# SPDX-License-Identifier: MIT
# Original, bounded workspace transfer format. Never invoke archive extraction or follow links.
import os, sys, stat, json, struct
LIMIT = 8 * 1024 ** 3
ENTRIES = 200000
META = 64 * 1024 ** 2

def exact(stream, size):
    chunks = []; remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk: raise ValueError('Incomplete backup')
        chunks.append(chunk); remaining -= len(chunk)
    return b''.join(chunks)

def record(stream, value):
    data = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()
    if len(data) > 16384: raise ValueError('Backup path is too long')
    stream.write(struct.pack('>I', len(data))); stream.write(data)
    return len(data)

def pack(root, output):
    entries = []; size = 0; metadata = 0
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = os.path.join(folder, name); info = os.lstat(path)
            if stat.S_ISSOCK(info.st_mode): continue
            kind = 'file' if stat.S_ISREG(info.st_mode) else 'dir' if stat.S_ISDIR(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else None
            if not kind: raise ValueError('Backup cannot contain device files or named pipes')
            relative = os.path.relpath(path, root)
            if len(relative.encode('utf-8')) > 4096: raise ValueError('Backup path is too long')
            entry = {'path': relative, 'kind': kind, 'mode': stat.S_IMODE(info.st_mode) & 0o777}
            if kind == 'file': entry['size'] = info.st_size; size += info.st_size
            if kind == 'link':
                entry['target'] = os.readlink(path)
                if len(entry['target'].encode('utf-8')) > 4096: raise ValueError('Backup link is too long')
            metadata += len(json.dumps(entry, ensure_ascii=True, separators=(',', ':')).encode())
            entries.append(entry)
            if len(entries) > ENTRIES or size > LIMIT or metadata > META - 128:
                raise ValueError('Backup supports up to 8 GB, 200,000 entries and 64 MB of metadata')
    for entry in entries:
        record(output, entry)
        if entry['kind'] == 'file':
            fd = os.open(os.path.join(root, entry['path']), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as source:
                current = os.fstat(source.fileno())
                if not stat.S_ISREG(current.st_mode) or current.st_size != entry['size']: raise ValueError('Backup source changed')
                left = entry['size']
                while left:
                    chunk = source.read(min(left, 65536))
                    if not chunk: raise ValueError('Backup source changed')
                    output.write(chunk); left -= len(chunk)
    record(output, {'end': True, 'files': len(entries), 'bytes': size})
    output.flush()

def unpack(root, source):
    if os.listdir(root): raise ValueError('Backup import requires an empty workspace')
    seen = set(); directories = []; size = 0; metadata = 0
    while True:
        length = struct.unpack('>I', exact(source, 4))[0]
        if not 0 < length <= 16384: raise ValueError('Invalid backup entry')
        metadata += length
        if metadata > META: raise ValueError('Backup metadata exceeds its limit')
        entry = json.loads(exact(source, length))
        if not isinstance(entry, dict): raise ValueError('Invalid backup entry')
        if entry.get('end') is True:
            if entry != {'end': True, 'files': len(seen), 'bytes': size} or source.read(1): raise ValueError('Incomplete backup')
            for path, mode in reversed(directories): os.chmod(path, mode)
            os.sync()
            return {'files': len(seen), 'bytes': size}
        relative = entry.get('path'); kind = entry.get('kind'); mode = entry.get('mode')
        if not isinstance(relative, str) or not relative or len(relative.encode('utf-8')) > 4096 or '\0' in relative:
            raise ValueError('Invalid backup path')
        parts = relative.split('/')
        if any(part in ('', '.', '..') for part in parts) or relative in seen:
            raise ValueError('Invalid or duplicate backup path')
        if len(seen) >= ENTRIES or type(mode) is not int or not 0 <= mode <= 0o777:
            raise ValueError('Invalid backup metadata')
        parent = root
        for part in parts[:-1]:
            parent = os.path.join(parent, part)
            if not stat.S_ISDIR(os.lstat(parent).st_mode): raise ValueError('Backup parent is not a directory')
        path = os.path.join(root, relative)
        if kind == 'dir' and set(entry) == {'path', 'kind', 'mode'}:
            os.mkdir(path, 0o700); directories.append((path, mode))
        elif kind == 'link' and set(entry) == {'path', 'kind', 'mode', 'target'}:
            target = entry['target']
            if not isinstance(target, str) or not target or '\0' in target or len(target.encode('utf-8')) > 4096: raise ValueError('Invalid backup link')
            os.symlink(target, path)
        elif kind == 'file' and set(entry) == {'path', 'kind', 'mode', 'size'}:
            length = entry['size']
            if type(length) is not int or length < 0 or size + length > LIMIT: raise ValueError('Backup exceeds its size limit')
            size += length
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                left = length
                while left:
                    chunk = exact(source, min(left, 65536)); output.write(chunk); left -= len(chunk)
                os.fchmod(output.fileno(), mode)
        else: raise ValueError('Unsupported backup entry')
        seen.add(relative)

if __name__ == '__main__':
    try:
        if sys.argv[1] == 'pack': pack('/source', sys.stdout.buffer)
        elif sys.argv[1] == 'unpack': print(json.dumps(unpack('/workspace', sys.stdin.buffer)))
        else: raise ValueError('Invalid operation')
    except Exception:
        # File names, contents and environment must not appear in server diagnostics.
        sys.stderr.write('Computer backup transfer failed: invalid data, unsupported files, access, or free space.\n')
        sys.exit(1)
