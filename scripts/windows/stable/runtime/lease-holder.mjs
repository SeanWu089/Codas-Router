// Supplemental POSIX test host only. On Windows the PS5 helper holds a native
// FileShare.None FileStream. flock wraps this process and owns the Unix lease.
console.log('{"acquired":true}');
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.includes('STOP')) process.exit(0); });
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
