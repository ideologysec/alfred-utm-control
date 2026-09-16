ObjC.import('Foundation');

// argv: cache path, content signature (empty disables cache), config paths in glob order.
// stdout: exactly eight NUL-terminated UTF-8 fields per VM, in this order:
// UUID, icon, icon_custom, backend, arch, cpu_count, memory_mb, boot_os.
// Missing optional values are empty fields; projected strings may not contain NUL.
var schema = 1;
var fields = ['icon', 'icon_custom', 'backend', 'arch', 'cpu_count', 'memory_mb', 'boot_os'];
var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dictionary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected dictionary');
    }
    return value;
}

function optionalDictionary(value) {
    return value === undefined ? {} : dictionary(value);
}

function optional(value) {
    return value === undefined ? null : value;
}

function validateRecord(record) {
    dictionary(record);
    if (Object.keys(record).length !== fields.length) throw new Error('Invalid metadata record');
    fields.forEach(function (field) {
        var value = record[field];
        if (value === null) return;
        if (field === 'icon_custom') {
            if (typeof value !== 'boolean') throw new Error('Expected boolean');
        } else if (field === 'cpu_count' || field === 'memory_mb') {
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
                throw new Error('Expected nonnegative integer');
            }
        } else if (typeof value !== 'string' || value.indexOf('\0') !== -1) {
            throw new Error('Expected NUL-free string');
        }
    });
    return record;
}

function readConfig(path) {
    var data = $.NSData.dataWithContentsOfFile($(path));
    if (!data) throw new Error('Cannot read config');
    var plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
    var config = dictionary(ObjC.deepUnwrap(plist));
    var information = dictionary(config.Information);
    var uuid = information.UUID;
    if (typeof uuid !== 'string' || uuid.length !== 36 || !uuidPattern.test(uuid)) throw new Error('Invalid UUID');
    var system = optionalDictionary(config.System);
    var boot = optionalDictionary(system.Boot);
    return {
        uuid: uuid,
        record: validateRecord({
            icon: optional(information.Icon),
            icon_custom: optional(information.IconCustom),
            backend: optional(config.Backend),
            arch: optional(system.Architecture),
            cpu_count: optional(system.CPUCount),
            memory_mb: optional(system.MemorySize),
            boot_os: optional(boot.OperatingSystem)
        })
    };
}

function readCache(path, signature) {
    try {
        var text = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
        var cache = JSON.parse(ObjC.unwrap(text));
        if (cache.schema !== schema || cache.signature !== signature) return null;
        var records = dictionary(cache.records);
        Object.keys(records).forEach(function (uuid) {
            if (uuid.length !== 36 || !uuidPattern.test(uuid)) throw new Error('Invalid cached UUID');
            validateRecord(records[uuid]);
        });
        return records;
    } catch (_) {
        return null;
    }
}

function writeCache(path, signature, records) {
    try {
        var parent = $(path).stringByDeletingLastPathComponent;
        if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
            parent, true, $(), null)) return;
        var data = $(JSON.stringify({schema: schema, signature: signature, records: records}))
            .dataUsingEncoding($.NSUTF8StringEncoding);
        // Foundation publishes a complete replacement; readers never see a partial file.
        data.writeToFileAtomically($(path), true);
    } catch (_) {
        // Cache availability must not affect live metadata.
    }
}

function run(argv) {
    var cachePath = argv[0];
    var signature = argv[1];
    var records = signature ? readCache(cachePath, signature) : null;
    if (records === null) {
        records = Object.create(null);
        var complete = true;
        argv.slice(2).forEach(function (path) {
            try {
                var metadata = readConfig(path);
                records[metadata.uuid] = metadata.record;
            } catch (_) {
                complete = false;
            }
        });
        // A failed config may recover without changing the supplied signature.
        if (signature && complete) writeCache(cachePath, signature, records);
    }

    var output = [];
    Object.keys(records).forEach(function (uuid) {
        output.push(uuid);
        fields.forEach(function (field) {
            var value = records[uuid][field];
            output.push(value === null ? '' : String(value));
        });
    });
    if (output.length) {
        var bytes = $(output.join('\0') + '\0').dataUsingEncoding($.NSUTF8StringEncoding);
        $.NSFileHandle.fileHandleWithStandardOutput.writeData(bytes);
    }
    // No return value: osascript's result rendering would trim/alter the framing.
}
