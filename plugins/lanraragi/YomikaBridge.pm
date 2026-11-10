package LANraragi::Plugin::Scripts::YomikaBridge;

use strict;
use warnings;
use JSON::PP ();
use Digest::SHA qw(sha256_hex);
use Encode qw(encode);
use POSIX qw(strftime);
use Time::HiRes ();

our $PREFIX = 'YOMIKA_BRIDGE_V1:';
my $JSON = JSON::PP->new->canonical->ascii->allow_nonref;

sub plugin_info {
    return (name => 'Yomika Bridge', type => 'script', namespace => 'yomikabridge',
        author => 'Yomika', version => '1.1.0', parameters => {},
        description => 'Versioned shared reading state, search presets and nonduplicate marks. No archive changes.',
        oneshot_arg => 'Protocol v1 JSON request');
}

sub integer { defined($_[0]) && !ref($_[0]) && $_[0] =~ /\A(?:0|[1-9][0-9]{0,14})\z/ }
sub archive_id { defined($_[0]) && !ref($_[0]) && $_[0] =~ /\A[0-9a-f]{40}\z/ }
sub token { defined($_[0]) && !ref($_[0]) && $_[0] =~ /\A[A-Za-z0-9_.:-]{1,96}\z/ }
sub default_state {
    return {archiveId => $_[0], version => 0, generation => 0,
        progress => undef, historyAt => undef, watchlistAt => undef};
}
sub timestamp {
    my $time = Time::HiRes::time();
    return strftime('%Y-%m-%dT%H:%M:%S', gmtime(int($time))) . sprintf('.%03dZ', int(($time-int($time))*1000));
}
sub fail { die "$_[0]\n" }

sub collection_name { defined($_[0]) && !ref($_[0]) && $_[0] =~ /\A(?:search_presets|non_duplicates)\z/ }
sub text_value { defined($_[0]) && !ref($_[0]) && $JSON->encode($_[0]) =~ /\A"/ }
sub validate_collection {
    my ($op) = @_;
    fail('BRIDGE_INVALID_REQUEST') unless ref($op) eq 'HASH' && token($op->{id})
        && collection_name($op->{collection}) && token($op->{key})
        && integer($op->{expectedVersion}) && exists($op->{value});
    my $v = $op->{value};
    if ($op->{collection} eq 'non_duplicates') {
        my ($a,$b) = split /:/, $op->{key}, -1;
        fail('BRIDGE_INVALID_REQUEST') unless archive_id($a) && archive_id($b) && $a lt $b && $op->{key} eq "$a:$b";
        if (defined $v) {
            fail('BRIDGE_INVALID_REQUEST') unless ref($v) eq 'HASH' && keys(%$v) == 2
                && text_value($v->{archiveIdA}) && text_value($v->{archiveIdB})
                && $v->{archiveIdA} eq $a && $v->{archiveIdB} eq $b;
        }
    } elsif (defined $v) {
        fail('BRIDGE_INVALID_REQUEST') unless ref($v) eq 'HASH' && keys(%$v) == 5
            && text_value($v->{name}) && $v->{name} =~ /\S/ && length($v->{name}) <= 256
            && text_value($v->{query}) && text_value($v->{sortBy}) && $v->{sortBy} =~ /\A(?:title|added)\z/
            && text_value($v->{sortOrder}) && $v->{sortOrder} =~ /\A(?:asc|desc)\z/
            && exists($v->{categoryId}) && (!defined($v->{categoryId}) || (text_value($v->{categoryId}) && length($v->{categoryId}) <= 256));
    }
    fail('BRIDGE_TOO_LARGE') if length(encode('UTF-8', JSON::PP->new->canonical->allow_nonref->encode($v))) > 4000;
}

# Pure validation/transition; timestamps are supplied by the server, never trusted from a client.
sub transition {
    my ($state, $op, $now) = @_;
    fail('BRIDGE_INVALID_REQUEST') unless ref($op) eq 'HASH' && token($op->{id})
        && archive_id($op->{archiveId}) && integer($op->{expectedVersion}) && integer($op->{generation});
    my $kind = $op->{kind} // '';
    fail('BRIDGE_INVALID_REQUEST') unless !ref($kind) && $kind =~ /\A(?:progress|watchlist_add|watchlist_remove|history_delete|progress_clear)\z/;
    my $next = $JSON->decode($JSON->encode($state));
    if ($kind eq 'progress') {
        my $p = $op->{progress};
        fail('BRIDGE_INVALID_REQUEST') unless ref($p) eq 'HASH' && integer($p->{pageIndex})
            && integer($p->{pageCount}) && $p->{pageCount} > 0 && $p->{pageCount} <= 1000000
            && $p->{pageIndex} < $p->{pageCount}
            && defined($p->{layout}) && !ref($p->{layout}) && $p->{layout} =~ /\A(?:paged|continuous)\z/
            && defined($p->{direction}) && !ref($p->{direction}) && $p->{direction} =~ /\A(?:ltr|rtl)\z/
            && (!defined($p->{coverAlone}) || JSON::PP::is_bool($p->{coverAlone}) || (!ref($p->{coverAlone}) && $p->{coverAlone} =~ /\A[01]\z/));
        fail('BRIDGE_INVALID_REQUEST') if defined($op->{allowProgressRegression}) && !JSON::PP::is_bool($op->{allowProgressRegression});
        if (!$op->{allowProgressRegression} && $state->{progress} && $p->{pageIndex} < $state->{progress}{pageIndex}) {
            $p = {%$p, pageIndex => $state->{progress}{pageIndex}, pageCount => $state->{progress}{pageCount}};
        }
        $next->{progress} = {map {$_ => $p->{$_}} qw(pageIndex pageCount layout direction coverAlone)};
        $next->{progress}{coverAlone} = defined($p->{coverAlone}) ? ($p->{coverAlone} ? JSON::PP::true : JSON::PP::false)
            : ($state->{progress} ? $state->{progress}{coverAlone} : undef);
        $next->{progress}{updatedAt} = $now;
        $next->{historyAt} = $now;
        $next->{watchlistAt} = undef if ($p->{pageIndex} + 1) / $p->{pageCount} > 0.9;
    } elsif ($kind eq 'watchlist_add') { $next->{watchlistAt} //= $now;
    } elsif ($kind eq 'watchlist_remove') { $next->{watchlistAt} = undef;
    } elsif ($kind eq 'history_delete') { $next->{historyAt} = undef;
    } else {
        $next->{progress} = undef; $next->{historyAt} = undef; $next->{generation}++;
    }
    return undef if $state->{version} != $op->{expectedVersion} || $state->{generation} != $op->{generation};
    $next->{version}++;
    return $next;
}

# Each invocation is a single Redis transaction. The result ledger intentionally has no TTL:
# a delayed retry must return the original result even after subsequent writes.
our $LUA = <<'LUA';
local p=KEYS[1]
local req=cjson.decode(ARGV[1])
redis.call('HSETNX',p..'meta','serverId',ARGV[2])
redis.call('HSETNX',p..'meta','epoch',ARGV[3])
redis.call('HSETNX',p..'meta','version',0)
local function envelope(v)
 v.protocol=1; v.serverId=redis.call('HGET',p..'meta','serverId'); v.epoch=redis.call('HGET',p..'meta','epoch')
 v.version=tonumber(redis.call('HGET',p..'meta','version')); return v
end
local function empty(id) return {archiveId=id,version=0,generation=0,progress=cjson.null,historyAt=cjson.null,watchlistAt=cjson.null} end
local function state(id) local s=redis.call('HGET',p..'states',id); if s then return cjson.decode(s) else return empty(id) end end
local function workspace(key)
 local s=redis.call('HGET',p..'workspaces',key)
 if s then return cjson.decode(s) else return {key=key,version=0,valueJson='null'} end
end
local function workspace_response(w,err)
 local out=envelope({})
 if err then out.error=err; out.errorCode=err end
 local meta=cjson.encode(out)
 return string.sub(meta,1,-2)..',"workspace":{"key":'..cjson.encode(w.key)..',"version":'..w.version..',"value":'..w.valueJson..'}}'
end
local function record(collection,key)
 local s=redis.call('HGET',p..'collection:'..collection,key)
 if s then return cjson.decode(s) else return {collection=collection,key=key,version=0,valueJson='null',createdAt=cjson.null,updatedAt=cjson.null} end
end
local function record_json(r)
 return '{"collection":'..cjson.encode(r.collection)..',"key":'..cjson.encode(r.key)..',"version":'..r.version..',"createdAt":'..cjson.encode(r.createdAt)..',"updatedAt":'..cjson.encode(r.updatedAt)..',"value":'..r.valueJson..'}'
end
local function record_response(r,err)
 local out=envelope({}); if err then out.error=err; out.errorCode=err end
 return string.sub(cjson.encode(out),1,-2)..',"record":'..record_json(r)..'}'
end
local function conflict(v)
 v.error='BRIDGE_CONFLICT'; v.errorCode='BRIDGE_CONFLICT'
 local result=cjson.encode(envelope(v))
 redis.call('HSET',p..'operations',req.operationId,cjson.encode({digest=req.digest,result=result}))
 return result
end
local action=req.action
if action=='reconcile_candidates' then
 local out={}; local pairs={}
 for _,entry in ipairs({{'records','readingCursor',out},{'collection_index:non_duplicates','pairCursor',pairs}}) do
  local total=redis.call('ZCARD',p..entry[1]); local offset=tonumber(redis.call('HGET',p..'meta',entry[2]) or '0')
  if offset>=total then offset=0 end
  for _,key in ipairs(redis.call('ZRANGE',p..entry[1],offset,offset+19)) do
   table.insert(entry[3],entry[1]=='records' and state(key) or record('non_duplicates',key))
  end
  redis.call('HSET',p..'meta',entry[2],offset+20)
 end
 return cjson.encode({states=out,records=pairs})
end
if action=='reconcile' then
 for _,observed in ipairs(req.states) do
  local s=state(observed.archiveId)
  if s.version==observed.version and (s.progress~=cjson.null or s.historyAt~=cjson.null or s.watchlistAt~=cjson.null) then
   s.progress=cjson.null; s.historyAt=cjson.null; s.watchlistAt=cjson.null; s.generation=s.generation+1; s.version=s.version+1
   redis.call('HSET',p..'states',s.archiveId,cjson.encode(s))
   redis.call('ZREM',p..'history',s.archiveId); redis.call('ZREM',p..'watchlist',s.archiveId)
   redis.call('ZADD',p..'records',redis.call('HINCRBY',p..'meta','version',1),s.archiveId)
  end
 end
 for _,observed in ipairs(req.records) do
  local r=record('non_duplicates',observed.key)
  if r.version==observed.version and r.valueJson~='null' then
   r.valueJson='null'; r.version=r.version+1; r.updatedAt=req.now
   redis.call('HSET',p..'collection:non_duplicates',r.key,cjson.encode(r))
   redis.call('HINCRBY',p..'meta','version',1)
  end
 end
 return cjson.encode(envelope({}))
end
if action=='hello' then return cjson.encode(envelope({capabilities={states=true,history=true,watchlist=true,workspace=true,collections=true,export=true,coverStatus=false,push=false},limits={requestBytes=6000,states=50,page=100,workspaceBytes=1800,collectionPage=50,collectionValueBytes=4000}})) end
if action=='states' then
 local out={}; for _,id in ipairs(req.ids) do table.insert(out,state(id)) end
 return cjson.encode(envelope({states=out}))
end
if action=='list' or action=='export' then
 local key=p..(action=='export' and 'records' or req.kind)
 local ids=redis.call('ZREVRANGE',key,req.offset,req.offset+req.limit-1)
 local out={}; for _,id in ipairs(ids) do table.insert(out,state(id)) end
 return cjson.encode(envelope({states=out,total=redis.call('ZCARD',key)}))
end
if action=='workspace_get' then return workspace_response(workspace(req.key)) end
if action=='collection_get' then return record_response(record(req.collection,req.key)) end
if action=='collection_list' then
 local key=p..'collection_index:'..req.collection
 local keys=redis.call('ZRANGE',key,req.offset,req.offset+req.limit-1)
 local records={}; for _,k in ipairs(keys) do table.insert(records,record_json(record(req.collection,k))) end
 local out=cjson.encode(envelope({collection=req.collection,total=redis.call('ZCARD',key)}))
 return string.sub(out,1,-2)..',"records":['..table.concat(records,',')..']}'
end
local cached=redis.call('HGET',p..'operations',req.operationId)
if cached then
 local old=cjson.decode(cached)
 if old.digest~=req.digest then return cjson.encode(envelope({error='BRIDGE_OPERATION_REUSED',errorCode='BRIDGE_OPERATION_REUSED'})) end
 return old.result
end
local result
if action=='apply' then
 local current=state(req.archiveId)
 if current.version~=req.expectedVersion or current.generation~=req.generation then return conflict({state=current}) end
 if not req.next then return conflict({state=current}) end
 local s=req.next
 redis.call('HSET',p..'states',req.archiveId,cjson.encode(s))
 local version=redis.call('HINCRBY',p..'meta','version',1)
 redis.call('ZADD',p..'records',version,req.archiveId)
 for _,kind in ipairs({'history','watchlist'}) do
  local field=kind=='history' and 'historyAt' or 'watchlistAt'
  if s[field]==cjson.null then redis.call('ZREM',p..kind,req.archiveId)
  elseif s[field]~=current[field] then redis.call('ZADD',p..kind,version,req.archiveId) end
 end
 result=cjson.encode(envelope({state=s}))
elseif action=='collection_apply' then
 local r=record(req.collection,req.key)
 if r.version~=req.expectedVersion then
  result=record_response(r,'BRIDGE_CONFLICT')
 else
  if r.version==0 then r.createdAt=req.now end
  r.version=r.version+1; r.valueJson=req.valueJson; r.updatedAt=req.now
  redis.call('HSET',p..'collection:'..req.collection,req.key,cjson.encode(r))
  redis.call('ZADD',p..'collection_index:'..req.collection,0,req.key)
  redis.call('HINCRBY',p..'meta','version',1)
  result=record_response(r)
 end
elseif action=='workspace_put' then
 local w=workspace(req.key)
 if w.version~=req.expectedVersion then
  local result=workspace_response(w,'BRIDGE_CONFLICT')
  redis.call('HSET',p..'operations',req.operationId,cjson.encode({digest=req.digest,result=result}))
  return result
 end
 w.version=w.version+1; w.valueJson=req.valueJson
 redis.call('HSET',p..'workspaces',req.key,cjson.encode(w))
 redis.call('HINCRBY',p..'meta','version',1)
 result=workspace_response(w)
end
redis.call('HSET',p..'operations',req.operationId,cjson.encode({digest=req.digest,result=result}))
return result
LUA

sub dispatch {
    my ($redis, $archives, $req) = @_;
    fail('BRIDGE_INVALID_REQUEST') unless ref($req) eq 'HASH' && integer($req->{protocol}) && $req->{protocol} == 1;
    my $action = $req->{action} // '';
    fail('BRIDGE_INVALID_REQUEST') unless !ref($action) && $action =~ /\A(?:hello|states|list|export|apply|workspace_get|workspace_put|collection_list|collection_get|collection_apply)\z/;
    my %arg = %$req;
    if ($action eq 'states') {
        fail('BRIDGE_INVALID_REQUEST') unless ref($req->{ids}) eq 'ARRAY' && @{$req->{ids}} >= 1 && @{$req->{ids}} <= 50;
        fail('BRIDGE_INVALID_REQUEST') for grep {!archive_id($_)} @{$req->{ids}};
    } elsif ($action eq 'list' || $action eq 'export') {
        fail('BRIDGE_INVALID_REQUEST') unless integer($req->{offset}) && integer($req->{limit}) && $req->{limit} >= 1 && $req->{limit} <= 100;
        fail('BRIDGE_INVALID_REQUEST') if $action eq 'list' && (ref($req->{kind}) || ($req->{kind} // '') !~ /\A(?:history|watchlist)\z/);
    } elsif ($action eq 'collection_list') {
        fail('BRIDGE_INVALID_REQUEST') unless collection_name($req->{collection}) && integer($req->{offset})
            && integer($req->{limit}) && $req->{limit} >= 1 && $req->{limit} <= 50;
    } elsif ($action eq 'collection_get') {
        validate_collection({id => 'read', collection => $req->{collection}, key => $req->{key}, expectedVersion => 0, value => undef});
    } elsif ($action eq 'collection_apply') {
        my $op = $req->{operation};
        validate_collection($op);
        my $digest = sha256_hex(encode('UTF-8', $JSON->encode($req)));
        my $cached = $redis->hget($PREFIX . 'operations', $op->{id});
        if (defined $cached) {
            my $old = $JSON->decode($cached);
            fail('BRIDGE_OPERATION_REUSED') unless $old->{digest} eq $digest;
            return $JSON->decode($old->{result});
        }
        if ($op->{collection} eq 'non_duplicates' && defined($op->{value})) {
            fail('BRIDGE_ARCHIVE_NOT_FOUND') unless $archives->hexists($op->{value}{archiveIdA}, 'file')
                && $archives->hexists($op->{value}{archiveIdB}, 'file');
        }
        %arg = (action => $action, operationId => $op->{id}, collection => $op->{collection}, key => $op->{key},
            expectedVersion => $op->{expectedVersion}, digest => $digest, valueJson => $JSON->encode($op->{value}), now => timestamp());
    } elsif ($action =~ /^workspace_/) {
        fail('BRIDGE_INVALID_REQUEST') unless token($req->{key});
        if ($action eq 'workspace_put') {
            fail('BRIDGE_INVALID_REQUEST') unless token($req->{operationId}) && integer($req->{expectedVersion}) && exists($req->{value});
            my $value_json = JSON::PP->new->canonical->allow_nonref->encode($req->{value});
            fail('BRIDGE_TOO_LARGE') if length(encode('UTF-8', $value_json)) > 1800;
            $arg{digest} = sha256_hex(encode('UTF-8', $JSON->encode($req)));
            $arg{valueJson} = $JSON->encode($req->{value});
        }
    } elsif ($action eq 'apply') {
        my $op = $req->{operation};
        fail('BRIDGE_INVALID_REQUEST') unless ref($op) eq 'HASH' && archive_id($op->{archiveId}) && token($op->{id});
        my $stored = $redis->hget($PREFIX . 'states', $op->{archiveId});
        my $state = defined($stored) ? $JSON->decode($stored) : default_state($op->{archiveId});
        my $next = transition($state, $op, timestamp());
        my $digest = sha256_hex(encode('UTF-8', $JSON->encode($req)));
        # Check the durable retry ledger before checking whether the archive still exists.
        my $cached = $redis->hget($PREFIX . 'operations', $op->{id});
        if (defined $cached) {
            my $old = $JSON->decode($cached);
            fail('BRIDGE_OPERATION_REUSED') unless $old->{digest} eq $digest;
            return $JSON->decode($old->{result});
        }
        if ($op->{kind} eq 'progress' || $op->{kind} eq 'watchlist_add') {
            fail('BRIDGE_ARCHIVE_NOT_FOUND') unless $archives->hexists($op->{archiveId}, 'file');
        }
        %arg = (action => 'apply', operationId => $op->{id}, archiveId => $op->{archiveId},
            expectedVersion => $op->{expectedVersion}, generation => $op->{generation}, next => $next, digest => $digest);
    }
    # IDs are persisted using HSETNX inside the same script, including concurrent first callers.
    my $entropy = join(':', time, $$, rand(), rand(), {});
    my $execute = sub {$JSON->decode($redis->eval($LUA, 1, $PREFIX, $JSON->encode($_[0]), sha256_hex($entropy), sha256_hex('epoch:' . $entropy)))};
    my $result = $execute->(\%arg);
    if ($action =~ /\A(?:hello|states|list|export|collection_list|collection_get)\z/) {
        my $candidates = $action eq 'hello' ? $execute->({action => 'reconcile_candidates'}) : $result;
        my (@missing_states, @missing_pairs);
        for my $s (ref($candidates->{states}) eq 'ARRAY' ? @{$candidates->{states}} : ()) {
            next unless defined($s->{progress}) || defined($s->{historyAt}) || defined($s->{watchlistAt});
            # Redis exceptions propagate. Only an explicit successful negative response proves absence.
            my $exists = $archives->hexists($s->{archiveId}, 'file');
            push @missing_states, {archiveId => $s->{archiveId}, version => $s->{version}} if defined($exists) && "$exists" eq '0';
        }
        my @records = ref($candidates->{records}) eq 'ARRAY' ? @{$candidates->{records}} : ();
        push @records, $candidates->{record} if ref($candidates->{record}) eq 'HASH';
        for my $r (@records) {
            next unless $r->{collection} eq 'non_duplicates';
            # Internal candidates carry raw JSON to preserve collection payload array/object types.
            my $v = exists($r->{valueJson}) ? $JSON->decode($r->{valueJson}) : $r->{value};
            next unless defined($v);
            my $a = $archives->hexists($v->{archiveIdA}, 'file');
            my $b = $archives->hexists($v->{archiveIdB}, 'file');
            push @missing_pairs, {key => $r->{key}, version => $r->{version}}
                if (defined($a) && "$a" eq '0') || (defined($b) && "$b" eq '0');
        }
        if (@missing_states || @missing_pairs) {
            $execute->({action => 'reconcile', states => \@missing_states, records => \@missing_pairs, now => timestamp()});
            if ($action eq 'list') {
                # Do not refill a deleted page with unchecked later IDs. Keep this read bounded.
                my @ids = map {$_->{archiveId}} @{$result->{states}};
                my $fresh = $execute->({action => 'states', ids => \@ids});
                my $field = $req->{kind} eq 'history' ? 'historyAt' : 'watchlistAt';
                $result = $execute->(\%arg);
                $result->{states} = [grep {defined($_->{$field})} @{$fresh->{states}}];
            } else {
                $result = $execute->(\%arg);
            }
        }
    }
    # Redis Lua cjson serializes its empty table as {}, not [].
    $result->{states} = [] if exists($result->{states}) && ref($result->{states}) eq 'HASH' && !keys(%{$result->{states}});
    return $result;
}

sub run_script {
    my ($class, $info) = @_;
    my ($redis, $archives, $result);
    my $ok = eval {
        my $raw = $info->{oneshot_param} // '';
        # Bound both decoded UTF-8 and percent-encoded query overhead, reserving route/plugin bytes.
        my $bytes = encode('UTF-8', $raw);
        my $encoded = $bytes; $encoded =~ s/([^A-Za-z0-9_.~-])/sprintf('%%%02X',ord($1))/ge;
        fail('BRIDGE_TOO_LARGE') if length($bytes) > 6000 || length($encoded) > 5900;
        my $req = $JSON->decode($raw);
        require LANraragi::Model::Config;
        $redis = LANraragi::Model::Config->get_redis_config;
        $archives = LANraragi::Model::Config->get_redis;
        $result = dispatch($redis, $archives, $req);
        1;
    };
    my $error = $@;
    if (!$ok && $redis) {
        my ($code) = $error =~ /(BRIDGE_[A-Z_]+)/;
        # Preserve the standard identity envelope for validation failures after connecting,
        # allowing clients to distinguish a permanent rejection from a lost connection.
        $result = eval {dispatch($redis, $archives, {protocol => 1, action => 'hello'})};
        if ($result) {
            $result->{error} = $result->{errorCode} = $code // 'BRIDGE_INTERNAL_ERROR';
        }
    }
    eval {$redis->quit} if $redis;
    eval {$archives->quit} if $archives;
    unless ($ok) {
        return %$result if $result;
        my ($code) = $error =~ /(BRIDGE_[A-Z_]+)/;
        $code //= 'BRIDGE_INTERNAL_ERROR';
        return (protocol => 1, error => $code, errorCode => $code);
    }
    return %$result;
}

1;
