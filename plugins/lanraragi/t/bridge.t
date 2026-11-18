use strict;
use warnings;
use utf8;
use Test::More;
use FindBin;
use JSON::PP;
require "$FindBin::Bin/../YomikaBridge.pm";
my $bridge = 'LANraragi::Plugin::Scripts::YomikaBridge';
my $id = 'a' x 40;
my $state = $bridge->can('default_state')->($id);
my $op = {id=>'op1', archiveId=>$id, kind=>'watchlist_add', expectedVersion=>0, generation=>0};
my $next = $bridge->can('transition')->($state,$op,'now');
is($next->{watchlistAt},'now','watchlist transition');
is($state->{version},0,'pure transition does not mutate input');
ok(!defined($bridge->can('transition')->($next,$op,'now')),'stale version conflict');
my $progress = {pageIndex=>89,pageCount=>100,layout=>'paged',direction=>'rtl',coverAlone=>JSON::PP::true};
$op = {%$op,id=>'p1',kind=>'progress',expectedVersion=>1,progress=>$progress};
my $p = $bridge->can('transition')->($next,$op,'time1');
is($p->{watchlistAt},'now','exactly 90 percent retains watchlist');
$op = {%$op,expectedVersion=>2,progress=>{%$progress,pageIndex=>90}};
my $p2 = $bridge->can('transition')->($p,$op,'time2');
ok(!defined($p2->{watchlistAt}),'over 90 percent removes watchlist');
my $lower = $bridge->can('transition')->($p2,{%$op,expectedVersion=>3,progress=>{%$progress,pageIndex=>1,coverAlone=>undef}},'time3');
is($lower->{progress}{pageIndex},90,'normal progress never regresses');
ok($lower->{progress}{coverAlone},'null cover preference preserves previous');
my $deleted = $bridge->can('transition')->($p2,{%$op,kind=>'history_delete',expectedVersion=>3},'time3');
ok(!defined($deleted->{historyAt}) && defined($deleted->{progress}),'history deletion keeps progress');
my $cleared = $bridge->can('transition')->($deleted,{%$op,kind=>'progress_clear',expectedVersion=>4},'time4');
is($cleared->{generation},1,'clear advances generation');
ok(!defined($cleared->{progress}),'clear removes progress');
eval {$bridge->can('transition')->($state,{%$op,expectedVersion=>0,progress=>{%$progress,pageCount=>0}},'now')};
like($@,qr/BRIDGE_INVALID_REQUEST/,'invalid count rejected');

# Optional real Redis integration: independent instance only, never a LANraragi server.
SKIP: {
    skip 'Set YOMIKA_TEST_REDIS_PORT for real Redis Lua integration', 95 unless $ENV{YOMIKA_TEST_REDIS_PORT};
    require IO::Socket::INET;
    {
        package TestRedis;
        sub new {bless {socket=>IO::Socket::INET->new(PeerAddr=>'127.0.0.1',PeerPort=>$ENV{YOMIKA_TEST_REDIS_PORT},Proto=>'tcp') || die($!)},shift}
        sub command {
            my ($self,@args)=@_; my $s=$self->{socket};
            print $s '*'.scalar(@args)."\r\n".join('',map {'$'.length($_)."\r\n$_\r\n"} @args);
            return $self->read_reply;
        }
        sub read_reply {
            my ($self)=@_; my $s=$self->{socket}; my $line=<$s>; die 'redis disconnected' unless defined $line;
            $line =~ s/\r\n$//; my $type=substr($line,0,1,'');
            die $line if $type eq '-';
            if ($type eq '$') {return undef if $line<0;my $buf='';while(length($buf)<$line+2){my $n=read($s,my $part,$line+2-length($buf));die 'short redis read' unless $n;$buf.=$part}return substr($buf,0,$line)}
            return $line;
        }
        sub hget {shift->command('HGET',@_)}
        sub hexists {my ($self,@args)=@_; die 'simulated archive Redis timeout' if $self->{archive_error}; return $self->command('HEXISTS',@args) if $self->{real_archives}; return $self->{missing} ? 0 : 1}
        sub eval {shift->command('EVAL',@_)}
        sub quit {}
    }
    my $r = TestRedis->new;
    no warnings 'once';
    local $LANraragi::Plugin::Scripts::YomikaBridge::PREFIX = 'YOMIKA_BRIDGE_TEST:'.$$.':';
    my $dispatch=$bridge->can('dispatch');
    my $call=sub {$dispatch->($r,$r,{protocol=>1,@_})};
    my $hello=$call->(action=>'hello');
    is($hello->{version},0,'new server global version');
    is($call->(action=>'hello')->{serverId},$hello->{serverId},'identity stable');
    my $operation={id=>'add',archiveId=>$id,kind=>'watchlist_add',expectedVersion=>0,generation=>0};
    my $added=$call->(action=>'apply',operation=>$operation);
    is($added->{state}{version},1,'Lua applies version');
    is($added->{version},1,'Lua advances global version');
    is($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>1)->{total},1,'indexed list');
    {
        local $LANraragi::Plugin::Scripts::YomikaBridge::PREFIX = $LANraragi::Plugin::Scripts::YomikaBridge::PREFIX . 'native:';
        my $native = 'e' x 40;
        my $now = time;
        my $req = {protocol=>1, action=>'list', kind=>'history', offset=>0, limit=>10};
        $r->command('HSET',$native,'file','test.cbz','lastreadtime',$now-20,'progress',8,'pagecount',10);
        is($dispatch->($r,$r,$req,0)->{total},0,'switch off skips external reading');
        is($dispatch->($r,$r,{%$req,offset=>1},1)->{total},0,'pagination does not rescan');
        my $imported = $dispatch->($r,$r,$req,1);
        is($imported->{total},1,'external LANraragi visit enters history');
        is($imported->{states}[0]{historyPageIndex},7,'native page converted to zero-based index');
        ok(!defined($imported->{states}[0]{progress}),'import does not replace shared reader settings');
        is($dispatch->($r,$r,$req,1)->{version},$imported->{version},'repeat reads are idempotent');
        my $remove = {id=>'native-delete',archiveId=>$native,kind=>'history_delete',expectedVersion=>1,generation=>0};
        my $deleted = $call->(action=>'apply',operation=>$remove);
        ok(!defined($deleted->{state}{historyAt}),'externally sourced history can be deleted');
        ok(!exists($deleted->{state}{historyPageIndex}),'delete clears external page metadata');
        my $meta = $LANraragi::Plugin::Scripts::YomikaBridge::PREFIX . 'meta';
        $r->command('HDEL',$meta,'nativeHistoryCompletedAt');
        is($dispatch->($r,$r,$req,1)->{total},0,'old native visit does not resurrect deleted history');
        $r->command('HSET',$native,'lastreadtime',$now-1);
        $r->command('HDEL',$meta,'nativeHistoryCompletedAt');
        is($dispatch->($r,$r,$req,1)->{total},0,'any native visit before deletion stays deleted');
        $r->command('DEL',$native);
    }
    my $conflict=$call->(action=>'apply',operation=>{%$operation,id=>'stale'});
    is($conflict->{errorCode},'BRIDGE_CONFLICT','Lua rejects stale concurrent writer');
    is($conflict->{state}{version},1,'conflict current state');
    my $removed=$call->(action=>'apply',operation=>{%$operation,id=>'remove',kind=>'watchlist_remove',expectedVersion=>1});
    is($removed->{state}{version},2,'second mutation');
    is_deeply($call->(action=>'apply',operation=>$operation),$added,'old retry returns original response after intervening write');
    is_deeply($call->(action=>'apply',operation=>{%$operation,id=>'stale'}),$conflict,'conflict retry also returns original response');
    is($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>5)->{total},0,'remove updates index');
    is_deeply($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>5)->{states},[],'empty Lua table normalized to array');
    is($call->(action=>'states',ids=>['b'x40])->{states}[0]{version},0,'missing default');
    is($call->(action=>'export',offset=>0,limit=>1)->{total},1,'export includes cleared records');
    my $w=$call->(action=>'workspace_put',key=>'dedup:0',operationId=>'work1',expectedVersion=>0,value=>{pairs=>[]});
    is($w->{workspace}{version},1,'workspace CAS');
    is($call->(action=>'workspace_put',key=>'dedup:0',operationId=>'work2',expectedVersion=>0,value=>{})->{errorCode},'BRIDGE_CONFLICT','workspace conflict');
    is($call->(action=>'workspace_get',key=>'dedup:0')->{workspace}{version},1,'workspace read');
    is($call->(action=>'hello')->{version},3,'hello reflects all successful mutations only');
    is_deeply($call->(action=>'workspace_get',key=>'dedup:0')->{workspace}{value},{pairs=>[]},'workspace preserves nested empty arrays');
    is_deeply($call->(action=>'workspace_put',key=>'dedup:0',operationId=>'work1',expectedVersion=>0,value=>{pairs=>[]}),$w,'workspace retry returns original response');
    $r->{missing}=1;
    eval {$call->(action=>'apply',operation=>{%$operation,id=>'missing',expectedVersion=>2})};
    like($@,qr/BRIDGE_ARCHIVE_NOT_FOUND/,'adding nonexistent archive rejected');
    my $clear=$call->(action=>'apply',operation=>{%$operation,id=>'clear',kind=>'progress_clear',expectedVersion=>2});
    is($clear->{state}{generation},1,'Lua persists generation after stale archive removal');
    is($call->(action=>'apply',operation=>{%$operation,id=>'oldgen',kind=>'history_delete',expectedVersion=>3})->{errorCode},'BRIDGE_CONFLICT','old generation rejected even at current version');
    eval {$call->(action=>'workspace_put',key=>'dedup:1',operationId=>'huge',expectedVersion=>0,value=>'a'x1801)};
    like($@,qr/BRIDGE_TOO_LARGE/,'workspace size bound');
    eval {$call->(action=>'apply',operation=>{%$operation,kind=>'history_delete'})};
    like($@,qr/BRIDGE_OPERATION_REUSED/,'operation ID reuse with different payload rejected');
    $r->{missing}=0;
    my $b='b'x40; my $c='c'x40;
    my $badd=$call->(action=>'apply',operation=>{%$operation,id=>'badd',archiveId=>$b});
    $call->(action=>'apply',operation=>{%$operation,id=>'cadd',archiveId=>$c});
    my $bagain=$call->(action=>'apply',operation=>{%$operation,id=>'bagain',archiveId=>$b,expectedVersion=>1});
    is($bagain->{state}{watchlistAt},$badd->{state}{watchlistAt},'repeated add preserves original addition time');
    is($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>10)->{states}[0]{archiveId},$c,'repeated add does not reorder watchlist');
    $call->(action=>'apply',operation=>{%$operation,id=>'bprogress',archiveId=>$b,kind=>'progress',expectedVersion=>2,progress=>{%$progress,pageIndex=>1}});
    is($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>10)->{states}[0]{archiveId},$c,'progress does not reorder watchlist');
    $call->(action=>'apply',operation=>{%$operation,id=>'cprogress',archiveId=>$c,kind=>'progress',expectedVersion=>1,progress=>{%$progress,pageIndex=>1}});
    $call->(action=>'apply',operation=>{%$operation,id=>'bremove',archiveId=>$b,kind=>'watchlist_remove',expectedVersion=>3});
    is($call->(action=>'list',kind=>'history',offset=>0,limit=>10)->{states}[0]{archiveId},$c,'watchlist removal does not reorder history');
    {
        package LANraragi::Model::Config;
        our $TEST_REDIS;
        sub get_redis_config {$TEST_REDIS}
        sub get_redis {$TEST_REDIS}
    }
    local $INC{'LANraragi/Model/Config.pm'}=1;
    local $LANraragi::Model::Config::TEST_REDIS=$r;
    $r->{missing}=1;
    my %failure=$bridge->run_script({oneshot_param=>JSON::PP->new->encode({protocol=>1,action=>'apply',operation=>{%$operation,id=>'wrapper-missing',archiveId=>'d'x40}})});
    is($failure{errorCode},'BRIDGE_ARCHIVE_NOT_FOUND','actual Script wrapper returns permanent validation code');
    is($failure{serverId},$hello->{serverId},'Script rejection retains identity envelope');
    $r->{missing}=0;
    ok($call->(action=>'hello')->{capabilities}{collections},'advertises hosted collections');
    my $preset={name=>'Saved search',query=>'artist:test',sortBy=>'added',sortOrder=>'desc',categoryId=>undef};
    my $cop={id=>'preset-create',collection=>'search_presets',key=>'preset-001',expectedVersion=>0,value=>$preset};
    my $created=$call->(action=>'collection_apply',operation=>$cop);
    is($created->{record}{version},1,'preset per-record CAS');
    is_deeply($created->{record}{value},$preset,'preset value preserved');
    like($created->{record}{createdAt},qr/^\d{4}-\d\d-\d\dT/,'record created timestamp supplied');
    is($created->{record}{updatedAt},$created->{record}{createdAt},'initial record timestamps match');
    my $pconflict=$call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-stale'});
    is($pconflict->{errorCode},'BRIDGE_CONFLICT','collection stale write conflicts');
    is_deeply($pconflict->{record},$created->{record},'collection conflict returns current record');
    my $tombstone=$call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-delete',expectedVersion=>1,value=>undef});
    is($tombstone->{record}{version},2,'deletion advances per-record version');
    ok(!defined($tombstone->{record}{value}),'deletion retains null tombstone');
    is($tombstone->{record}{createdAt},$created->{record}{createdAt},'deletion preserves original creation');
    is_deeply($call->(action=>'collection_apply',operation=>$cop),$created,'collection retry returns original before tombstone');
    is_deeply($call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-stale'}),$pconflict,'collection conflict ledger permanent');
    is($call->(action=>'collection_get',collection=>'search_presets',key=>'unknown')->{record}{version},0,'collection get supplies missing version0');
    is_deeply($call->(action=>'collection_get',collection=>'search_presets',key=>'preset-001')->{record},$tombstone->{record},'collection get retains tombstone');
    my $empty=$call->(action=>'collection_list',collection=>'non_duplicates',offset=>0,limit=>50);
    is_deeply($empty->{records},[],'empty collection records is JSON array');
    for my $n (2..65) {
        $call->(action=>'collection_apply',operation=>{%$cop,id=>"bulk-$n",key=>sprintf('preset-%03d',$n)});
    }
    my $page1=$call->(action=>'collection_list',collection=>'search_presets',offset=>0,limit=>50);
    my $page2=$call->(action=>'collection_list',collection=>'search_presets',offset=>50,limit=>50);
    is($page1->{total},65,'large collection has no whole-document cap');
    is(scalar(@{$page1->{records}}),50,'collection page bounded');
    is(scalar(@{$page2->{records}}),15,'collection trailing page');
    is($page1->{records}[0]{key},'preset-001','stable key ordering includes tombstones');
    my $pair={id=>'pair-create',collection=>'non_duplicates',key=>"$id:$b",expectedVersion=>0,value=>{archiveIdA=>$id,archiveIdB=>$b}};
    my $marked=$call->(action=>'collection_apply',operation=>$pair);
    is($marked->{record}{version},1,'nonduplicate mark hosted');
    $r->{missing}=1;
    is_deeply($call->(action=>'collection_apply',operation=>$pair),$marked,'retry succeeds after archive deletion');
    eval {$call->(action=>'collection_apply',operation=>{%$pair,id=>'pair-missing',expectedVersion=>1})};
    like($@,qr/BRIDGE_ARCHIVE_NOT_FOUND/,'new mark rejects deleted archive');
    is($call->(action=>'collection_apply',operation=>{%$pair,id=>'pair-remove',expectedVersion=>1,value=>undef})->{record}{version},2,'removed archive mark can be cleared');
    eval {$call->(action=>'collection_apply',operation=>{%$pair,id=>'reversed',key=>"$b:$id"})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'noncanonical pair rejected');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,id=>'invalid-preset',value=>{%$preset,sortBy=>'random'}})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'unsupported preset sort rejected');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-too-large',value=>{%$preset,query=>'語'x1400}})};
    like($@,qr/BRIDGE_TOO_LARGE/,'record value limit counts Unicode UTF8 bytes');
    my $unicode=$call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-unicode',key=>'unicode',value=>{%$preset,name=>'検索',query=>'語'x500}});
    is($unicode->{record}{value}{name},'検索','Unicode record survives Perl Redis Lua roundtrip');
    is($unicode->{record}{value}{query},'語'x500,'Unicode query survives roundtrip');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,id=>'preset-extra-field',value=>{%$preset,arbitrary=>[]}})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'unknown preset fields rejected');
    eval {$call->(action=>'collection_list',collection=>'search_presets',offset=>0,limit=>51)};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'oversized collection page rejected');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,value=>undef})};
    like($@,qr/BRIDGE_OPERATION_REUSED/,'collection operation ID payload reuse rejected');
    is($call->(action=>'collection_list',collection=>'search_presets',offset=>10000,limit=>50)->{total},66,'sparse page still returns accurate total');
    is_deeply($call->(action=>'collection_list',collection=>'search_presets',offset=>10000,limit=>50)->{records},[],'beyond-end page returns empty array');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,id=>'numeric-name',value=>{%$preset,name=>123}})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'numeric preset name rejected instead of string coercion');
    eval {$call->(action=>'collection_apply',operation=>{%$cop,id=>'numeric-query',value=>{%$preset,query=>123}})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'numeric preset query rejected instead of string coercion');
    $r->{missing}=0;
    $r->{real_archives}=1;
    my ($e,$f)=('e'x40,'f'x40);
    $r->command('HSET',$e,'file','/isolated/e.cbz');
    $r->command('HSET',$f,'file','/isolated/f.cbz');
    my $delete_op={id=>'deletion-progress',archiveId=>$e,kind=>'progress',expectedVersion=>0,generation=>0,progress=>{%$progress,pageIndex=>1}};
    $call->(action=>'apply',operation=>$delete_op);
    $call->(action=>'apply',operation=>{%$delete_op,id=>'deletion-watchlist',kind=>'watchlist_add',expectedVersion=>1});
    my $relation={id=>'deletion-pair',collection=>'non_duplicates',key=>"$e:$f",expectedVersion=>0,value=>{archiveIdA=>$e,archiveIdB=>$f}};
    $call->(action=>'collection_apply',operation=>$relation);
    $r->command('DEL',$e);
    $r->{archive_error}=1;
    eval {$call->(action=>'states',ids=>[$e])};
    like($@,qr/timeout/,'archive Redis error aborts reconciliation');
    my $unchanged=JSON::PP->new->decode($r->hget($LANraragi::Plugin::Scripts::YomikaBridge::PREFIX.'states',$e));
    is($unchanged->{version},2,'transient Redis error does not mutate record');
    ok(defined($unchanged->{progress}),'transient error keeps progress');
    $r->{archive_error}=0;
    my $clean=$call->(action=>'states',ids=>[$e]);
    my $s=$clean->{states}[0];
    is($s->{version},3,'proven archive deletion advances state version');
    is($s->{generation},1,'deletion advances generation');
    ok(!defined($s->{progress}) && !defined($s->{historyAt}) && !defined($s->{watchlistAt}),'deleted archive clears all reading fields');
    is($call->(action=>'list',kind=>'watchlist',offset=>0,limit=>100)->{total},0,'deleted archive removed from watchlist index');
    my $relation_clean=$call->(action=>'collection_get',collection=>'non_duplicates',key=>"$e:$f")->{record};
    is($relation_clean->{version},2,'deleted archive relation advances version');
    ok(!defined($relation_clean->{value}),'deleted archive relation becomes tombstone');
    is($call->(action=>'states',ids=>[$e])->{states}[0]{version},3,'repeated cleanup is idempotent');
    $r->command('HSET',$e,'file','/isolated/reimport.cbz');
    is($call->(action=>'apply',operation=>{%$delete_op,id=>'old-deleted-generation',expectedVersion=>3})->{errorCode},'BRIDGE_CONFLICT','old offline generation cannot resurrect reimported archive');
    $r->command('DEL',$e);
    my $fwatch=$call->(action=>'apply',operation=>{id=>'hello-cleanup',archiveId=>$f,kind=>'watchlist_add',expectedVersion=>0,generation=>0});
    $r->command('DEL',$f);
    $call->(action=>'hello');
    is(JSON::PP->new->decode($r->hget($LANraragi::Plugin::Scripts::YomikaBridge::PREFIX.'states',$f))->{generation},1,'hello sweeps unseen archive with bounded batch');
    is_deeply($call->(action=>'apply',operation=>{id=>'hello-cleanup',archiveId=>$f,kind=>'watchlist_add',expectedVersion=>0,generation=>0}),$fwatch,'cleanup does not rewrite original retry ledger');
    cmp_ok($call->(action=>'hello')->{version},'>',$clean->{version},'cleanup advances observable global version');
    $r->{real_archives}=0;
    $r->{missing}=0;
    my $large={%$preset,query=>'x'x3500};
    for my $n (1..50) {$call->(action=>'collection_apply',operation=>{%$cop,id=>"max-$n",key=>sprintf('max-%03d',$n),value=>$large})}
    my $max_page=$call->(action=>'collection_list',collection=>'search_presets',offset=>0,limit=>50);
    is(scalar(@{$max_page->{records}}),50,'maximum collection page remains bounded');
    cmp_ok(length(JSON::PP->new->ascii->encode($max_page)),'<',1300000,'maximum escaped aggregate response below1.3MB');
    eval {$call->(action=>'states',ids=>[($id)x51])};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'states batch above50 rejected');
    eval {$call->(action=>'export',offset=>0,limit=>101)};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'export page above100 rejected');
    eval {$call->(action=>'apply',operation=>{%$delete_op,id=>'invalid-stale-progress',progress=>{%$progress,pageCount=>0}})};
    like($@,qr/BRIDGE_INVALID_REQUEST/,'invalid payload rejected even when state version stale');
}
done_testing;
