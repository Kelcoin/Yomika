package app.yomika.reader

/** Crash writers bypass the Rust bridge; scrub private locations before disk. */
internal object LogRedaction {
  private val patterns = listOf(
    """(?i)\b(?:https?|wss?|ftp|file|content)://[^\s<>"'`),}]+""",
    """(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n\t"'<>|,;]+""",
    """/(?:home|Users|data/user|storage|mnt|media|private|tmp|var/folders)/[^\s"'<>),;]+""",
    """\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b""",
    """(?i)\[?(?:[\da-f]{0,4}::[\da-f:]+|(?:[\da-f]{0,4}:){3,}[\da-f:]+)(?:%[\w.-]+)?\]?(?::\d+)?""",
    """(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b""",
    """(?i)(?:Bearer|Basic)\s+[^\s,;]+""",
    """(?i)\b(?:api[_-]?key|token|password|passwd|passphrase|sync[_-]?secret|credential|secret|ipb_member_id|ipb_pass_hash|authorization|cookie|username|user[_-]?id|server[_-]?id|scope[_-]?id)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&#]+)""",
  ).map(::Regex)

  fun text(value: String): String = patterns.fold(value) { result, pattern -> pattern.replace(result, "[REDACTED]") }
}
