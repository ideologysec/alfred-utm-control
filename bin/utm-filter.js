ObjC.import('Foundation');

var schema = 1;
var fields = ['icon', 'icon_custom', 'backend', 'arch', 'cpu_count', 'memory_mb', 'boot_os'];
var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var environment = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
var files = $.NSFileManager.defaultManager;

function env(name, fallback) {
    return environment[name] || fallback || '';
}

function dictionary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected dictionary');
    return value;
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
        } else if (typeof value !== 'string') throw new Error('Expected string');
    });
    return record;
}

function readConfig(data) {
    if (!data) throw new Error('Cannot read config');
    var config = dictionary(ObjC.deepUnwrap(
        $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null)));
    var information = dictionary(config.Information);
    var uuid = information.UUID;
    if (typeof uuid !== 'string' || uuid.length !== 36 || !uuidPattern.test(uuid)) throw new Error('Invalid UUID');
    var system = config.System === undefined ? {} : dictionary(config.System);
    var boot = system.Boot === undefined ? {} : dictionary(system.Boot);
    function optional(value) { return value === undefined ? null : value; }
    return {uuid: uuid, record: validateRecord({
        icon: optional(information.Icon), icon_custom: optional(information.IconCustom),
        backend: optional(config.Backend), arch: optional(system.Architecture),
        cpu_count: optional(system.CPUCount), memory_mb: optional(system.MemorySize),
        boot_os: optional(boot.OperatingSystem)
    })};
}

function readText(path) {
    var text = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    if (!text) throw new Error('Cannot read ' + path);
    return ObjC.unwrap(text);
}

function command(executable, args, input, forwardStderr) {
    var directory = ObjC.unwrap($.NSTemporaryDirectory()) + 'alfred-utm-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    var handles = [];
    if (!files.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        $(directory), false, $({NSFilePosixPermissions: 448}), null)) {
        throw new Error('Could not capture UTM command diagnostics.');
    }
    try {
        // Regular files keep either stream from filling a pipe while we wait.
        ['stdout', 'stderr', 'stdin'].forEach(function (name) {
            var data = $(name === 'stdin' ? input || '' : '').dataUsingEncoding($.NSUTF8StringEncoding);
            if (!data.writeToFileAtomically($(directory + '/' + name), false)) {
                throw new Error('Could not capture UTM command diagnostics.');
            }
        });
        var stdout = $.NSFileHandle.fileHandleForWritingAtPath($(directory + '/stdout'));
        var stderr = $.NSFileHandle.fileHandleForWritingAtPath($(directory + '/stderr'));
        var stdin = $.NSFileHandle.fileHandleForReadingAtPath($(directory + '/stdin'));
        handles = [stdout, stderr, stdin];
        var task = $.NSTask.alloc.init;
        task.launchPath = $(executable);
        task.arguments = $(args);
        task.standardOutput = stdout;
        task.standardError = stderr;
        task.standardInput = stdin;
        var error = Ref();
        if (!task.launchAndReturnError(error)) {
            throw new Error(error[0] ? ObjC.unwrap(error[0].localizedDescription) : 'Could not launch ' + executable);
        }
        task.waitUntilExit;
        if (forwardStderr) {
            $.NSFileHandle.fileHandleWithStandardError.writeData(
                $.NSData.dataWithContentsOfFile($(directory + '/stderr')));
        }
        return {status: task.terminationStatus, stdout: readText(directory + '/stdout'), stderr: readText(directory + '/stderr')};
    } finally {
        handles.forEach(function (handle) { handle.closeFile; });
        files.removeItemAtPathError($(directory), null);
    }
}

function metadataSignature(docs, configs) {
    if (env('UTM_CACHE_DISABLE') === '1') return '';
    try {
        var contents = '';
        if (configs.length) {
            var checksums = command('/usr/bin/cksum', configs);
            if (checksums.status !== 0) return '';
            contents = checksums.stdout;
        }
        var signature = command('/usr/bin/cksum', [], 'metadata-schema=' + schema + '\ndocs=' + docs + '\n' + contents);
        return signature.status === 0 ? signature.stdout.trim() : '';
    } catch (_) { return ''; }
}

function readCache(path, signature) {
    try {
        var cache = JSON.parse(readText(path));
        if (cache.schema !== schema || cache.signature !== signature) return null;
        var records = dictionary(cache.records);
        Object.keys(records).forEach(function (uuid) {
            if (uuid.length !== 36 || !uuidPattern.test(uuid)) throw new Error('Invalid cached UUID');
            validateRecord(records[uuid]);
        });
        return records;
    } catch (_) { return null; }
}

function writeCache(path, signature, records) {
    try {
        if (!files.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
            $(path).stringByDeletingLastPathComponent, true, $(), null)) return;
        // Foundation atomically replaces the snapshot; failures never affect live data.
        $(JSON.stringify({schema: schema, signature: signature, records: records}))
            .dataUsingEncoding($.NSUTF8StringEncoding).writeToFileAtomically($(path), true);
    } catch (_) {}
}

function metadata() {
    var docs = env('UTM_DOCS_DIR', env('HOME') + '/Library/Containers/com.utmapp.UTM/Data/Documents');
    var cachePath = env('UTM_CACHE_DIR', env('alfred_workflow_cache', env('TMPDIR', '/tmp') + '/alfred-utm-cache')) + '/vm-metadata.json';
    var children = ObjC.deepUnwrap(files.contentsOfDirectoryAtPathError($(docs), null)) || [];
    var configs = children.sort().filter(function (name) { return /\.utm$/.test(name); }).map(function (name) {
        return docs + '/' + name + '/config.plist';
    }).filter(function (path) { return files.fileExistsAtPath($(path)); });
    var signature = metadataSignature(docs, configs);
    var records = signature ? readCache(cachePath, signature) : null;
    if (records !== null) return records;
    var complete = true;
    records = Object.create(null);
    configs.forEach(function (path) {
        try {
            var entry = readConfig($.NSData.dataWithContentsOfFile($(path)));
            records[entry.uuid] = entry.record;
        } catch (_) { complete = false; }
    });
    if (signature && complete) writeCache(cachePath, signature, records);
    return records;
}

function invalid(title, subtitle) {
    return {items: [{title: title, subtitle: subtitle, valid: false}]};
}

function context() {
    return {uuid: env('VM_UUID', env('vm_uuid')), name: env('VM_NAME', env('vm_name')),
        status: env('VM_STATUS', env('vm_status')), backend: env('VM_BACKEND', env('vm_backend'))};
}

function variables(vm, action, focus) {
    var result = {vm_uuid: vm.uuid, vm_name: vm.name, vm_status: vm.status, vm_backend: vm.backend || ''};
    if (action) result.vm_action = action;
    if (action === 'start' || action === 'start-disposable') result.UTM_FOCUS_AFTER_START = focus;
    return result;
}

function focusDefault() { return env('UTM_FOCUS_ON_START', env('utm_focus_on_start', '1')) === '1' ? '1' : '0'; }
function focusLabel(focus) { return focus === '1' ? 'bring UTM to front' : 'without bringing UTM to front'; }
function startLabel(action) { return action === 'start-disposable' ? 'Start without saving changes' : 'Start normally'; }

function actionPayload(vm, action, focus, arg, subtitle) {
    return {valid: true, subtitle: subtitle, arg: arg, variables: variables(vm, action, focus)};
}

function startPayload(vm, action, arg, shortcut) {
    var focus = focusDefault();
    var inverse = focus === '1' ? '0' : '1';
    var result = {variables: variables(vm, action, focus), mods: {
        cmd: actionPayload(vm, action, inverse, arg, 'Start (' + focusLabel(inverse) + ')')
    }};
    if (shortcut && vm.backend === 'QEMU') {
        var opposite = action === 'start' ? 'start-disposable' : 'start';
        result.mods.alt = actionPayload(vm, opposite, focus, arg, startLabel(opposite));
        result.mods['cmd+alt'] = actionPayload(vm, opposite, inverse, arg, startLabel(opposite) + ' and ' + focusLabel(inverse));
    }
    return result;
}

function labelFromIcon(icon) {
    var lower = icon.toLowerCase();
    if (lower === 'mac' || lower === 'macos') return 'macOS';
    if (lower === 'ios') return 'iOS';
    if (lower === 'nixos') return 'NixOS';
    if (/^windows/.test(lower)) return 'Windows';
    return lower.split('-').filter(Boolean).map(function (part) { return part[0].toUpperCase() + part.slice(1); }).join(' ');
}

function osLabel(record, name) {
    var icon = record.icon || '';
    if (icon && ['linux', 'bsd', 'unix', 'other'].indexOf(icon.toLowerCase()) === -1) return labelFromIcon(icon);
    if (record.boot_os) return record.boot_os;
    if (icon) return labelFromIcon(icon);
    var match = /^(ubuntu|nixos|windows|win11|win10|macos|rocky|linux|bsd)(?:$|[-_ ])/i.exec(name);
    if (!match) return '';
    return {ubuntu: 'Ubuntu', nixos: 'NixOS', windows: 'Windows', win11: 'Windows', win10: 'Windows',
        macos: 'macOS', rocky: 'Rocky Linux', linux: 'Linux', bsd: 'BSD'}[match[1].toLowerCase()];
}

function memoryLabel(memory) {
    if (memory === null || memory === undefined) return '';
    return memory < 1024 ? memory + ' MB' : Number((memory / 1024).toPrecision(10)) + ' GB';
}

function parseList(text) {
    var result = [];
    text.split('\n').forEach(function (line, index) {
        if (/^[ \t\r]*$/.test(line) || /^[ \t]*UUID[ \t]+STATUS[ \t]+NAME[ \t\r]*$/i.test(line)) return;
        // Only consume the column separators, never normalize the name itself.
        var row = /^[ \t]*([0-9a-f-]+)[ \t]+([^ \t\r]+)[ \t]+([^\n]+)$/i.exec(line);
        if (!row || row[1].length !== 36 || !uuidPattern.test(row[1]) || /^[ \t\r]*$/.test(row[3])) {
            throw new Error('Invalid utmctl list row ' + (index + 1) + ': expected UUID, status, and name.');
        }
        result.push({uuid: row[1], status: row[2], name: row[3]});
    });
    return result;
}

function list(mode) {
    var text;
    var records;
    try {
        if (env('UTMCTL_FIXTURE_LIST')) text = readText(env('UTMCTL_FIXTURE_LIST'));
        else {
            var executable = env('UTMCTL_BIN', '/Applications/UTM.app/Contents/MacOS/utmctl');
            if (!files.isExecutableFileAtPath($(executable))) return invalid('utmctl not found', 'Expected ' + executable);
            var result = command(executable, ['list'], '', true);
            if (result.status !== 0 || /^Error from event:/m.test(result.stderr)) {
                var diagnostic = result.stderr || result.stdout || 'UTM command failed (exit status ' + result.status + ').';
                return invalid('utmctl list failed', diagnostic.replace(/[\r\n]/g, ' ').trim());
            }
            text = result.stdout;
        }
        records = parseList(text);
    } catch (error) {
        console.log(String(error));
        return invalid('utmctl list failed', String(error.message || error).replace(/[\r\n]/g, ' ').trim());
    }
    var filter = mode === 'start' ? 'startable' : mode === 'stop' || mode === 'suspend' ? 'running' : 'all';
    records = records.filter(function (vm) {
        return filter === 'all' || (filter === 'running' ? ['running', 'started'] : ['stopped', 'suspended', 'paused']).indexOf(vm.status) !== -1;
    });
    if (!records.length) return invalid(filter === 'startable' ? 'No stopped or suspended VMs found' :
        filter === 'running' ? 'No running VMs found' : 'No VMs found', '');
    if (filter === 'startable') records.sort(function (a, b) { return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0; });
    var index = metadata();
    var iconDir = env('UTM_ICON_DIR', '/Applications/UTM.app/Contents/Resources/Icons');
    return {items: records.map(function (vm) {
        var record = index[vm.uuid] || {};
        vm.backend = record.backend || '';
        var label = osLabel(record, vm.name);
        var compute = [record.cpu_count === undefined || record.cpu_count === null ? '' : record.cpu_count + ' CPU', memoryLabel(record.memory_mb)].filter(Boolean).join(' / ');
        var item = {uid: vm.uuid, title: vm.name,
            subtitle: [vm.status, label, vm.backend, record.arch, compute].filter(Boolean).join(' - '),
            arg: vm.name, match: [vm.name, label, vm.backend, record.arch].filter(Boolean).join(' ')};
        if (mode === 'start') {
            var action = vm.backend === 'QEMU' && env('UTM_START_QEMU_DISPOSABLE', env('utm_start_qemu_disposable', '0')) === '1' ? 'start-disposable' : 'start';
            Object.assign(item, startPayload(vm, action, vm.name, true));
        } else item.variables = variables(vm);
        var iconPath = iconDir + '/' + record.icon + '.png';
        var isDirectory = Ref();
        if (record.icon && !record.icon_custom &&
            files.fileExistsAtPathIsDirectory($(iconPath), isDirectory) && !isDirectory[0]) item.icon = {path: iconPath};
        return item;
    })};
}

function actions() {
    var vm = context();
    if (!vm.uuid || !vm.name || !vm.status) return invalid('No VM selected', 'Search for a virtual machine and select it');
    var items = [];
    function add(title, subtitle, action) {
        var arg = action === 'clone' ? vm.name : vm.uuid;
        var item = {title: title, subtitle: subtitle, arg: arg};
        if (action === 'start' || action === 'start-disposable') Object.assign(item, startPayload(vm, action, arg, false));
        else item.variables = variables(vm, action);
        items.push(item);
    }
    if (['stopped', 'suspended', 'paused'].indexOf(vm.status) !== -1) {
        add('Start ' + vm.name, 'Start this virtual machine', 'start');
        if (vm.backend === 'QEMU') add('Run ' + vm.name + ' Without Saving Changes', 'Start in disposable mode', 'start-disposable');
    } else if (['running', 'started'].indexOf(vm.status) !== -1) {
        add('Stop ' + vm.name, 'Shut down this virtual machine', 'stop');
        add('Force Stop ' + vm.name, 'Power off this virtual machine', 'force-stop');
        add('Suspend ' + vm.name, 'Suspend this virtual machine', 'suspend');
        add('IP Address for ' + vm.name, 'Show this virtual machine\'s IP address', 'ip-address');
    }
    add('Clone ' + vm.name, 'Clone this virtual machine', 'clone');
    return {items: items};
}

function clone(name) {
    if (!name) return invalid('Enter a clone name', 'Clone name is required');
    var vm = context();
    if (!vm.uuid || !vm.name) return invalid('No VM selected', 'Search for a virtual machine and select it');
    return {items: [{title: 'Clone ' + vm.name + ' as ' + name,
        subtitle: 'utmctl clone ' + vm.uuid + ' --name ' + name, arg: 'clone',
        variables: {vm_uuid: vm.uuid, vm_name: vm.name, vm_action: 'clone', clone_name: name}}]};
}

function run(argv) {
    var output;
    switch (argv[0]) {
        case 'list':
            var started = Date.now();
            var mode = argv[1] || 'all';
            output = list(mode);
            if (env('UTM_DEBUG') === '1') console.log('[alfred-utm] vm-list mode=' + mode + ' state=live elapsed_ms=' + (Date.now() - started));
            break;
        case 'actions': output = actions(); break;
        case 'clone': output = clone(argv[1] || ''); break;
        default: throw new Error('Unknown filter mode');
    }
    return JSON.stringify(output);
}
