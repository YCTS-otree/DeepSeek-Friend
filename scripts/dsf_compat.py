"""Component-owned snapshot contracts. Creator appVersion is provenance, never a gate."""
import json
from collections import deque

DEFINITIONS = {
    'dsh_context': ('DSH 上下文与附件', 'dsh-session', None),
    'bridge_state': ('桥接、聊天与会话映射', 'bridge-state', 1),
    'cognitive_state': ('长期记忆与 Self Model（原子组）', 'cognitive-state', 1),
    'room': ('小房间', 'room-files', 1),
    'prompts': ('核心 Prompt', 'prompt-files', 1),
    'test_state': ('测试记忆与资源', 'test-state', 1),
}
# Code-owned migrations only. No executable instruction is loaded from a DSF.
MIGRATIONS = {}


def component_for(name):
    if name.startswith('dsh/'): return 'dsh_context'
    if name.startswith('prompts/'): return 'prompts'
    if name.startswith('data/cognitive/room/'): return 'room'
    if name.startswith('data/cognitive/'): return 'cognitive_state'
    if name.startswith('data/testing/'): return 'test_state'
    if name.startswith(('data/bridge.sqlite', 'data/interaction.sqlite', 'data/media/')): return 'bridge_state'
    return None


def dsh_version(root):
    file = root / '.runtime/node_modules/@deepseek-ai/dsh/package.json'
    return json.loads(file.read_text(encoding='utf-8'))['version'] if file.exists() else 'unknown'


def current_components(root):
    return {key: {'format': fmt, 'version': dsh_version(root) if key == 'dsh_context' else version}
            for key, (_label, fmt, version) in DEFINITIONS.items()}


def source_components(manifest):
    if manifest['schemaVersion'] == 2:
        return manifest['components']
    present = {component_for(name) for name in manifest['files']}
    return {key: {'format': fmt, 'version': manifest.get('dshVersion', 'unknown') if key == 'dsh_context' else 0,
                  'inferred': True} for key, (_label, fmt, _) in DEFINITIONS.items() if key in present}


def register_migration(component, source_format, source_version, target_format, target_version, name, migrate):
    key = (component, source_format, source_version, target_format, target_version)
    if component not in DEFINITIONS or key in MIGRATIONS or not callable(migrate):
        raise ValueError('dsf-migration-registration-invalid')
    MIGRATIONS[key] = (name, migrate)


def migration_path(component, source, target):
    start, end = (source['format'], source['version']), (target['format'], target['version'])
    queue = deque([(start, [])]); visited = {start}
    while queue:
        node, path = queue.popleft()
        if node == end: return path
        for key, migration in MIGRATIONS.items():
            family, fmt, version, to_fmt, to_version = key
            destination = (to_fmt, to_version)
            if family == component and node == (fmt, version) and destination not in visited:
                visited.add(destination); queue.append((destination, path + [(key, migration)]))
    return None


def compatibility(manifest, root, selected=None):
    source, target = source_components(manifest), current_components(root)
    if selected is None: selected = list(source)
    if not isinstance(selected, list) or not selected or any(not isinstance(k, str) or k not in source for k in selected) or len(selected) != len(set(selected)):
        raise ValueError('dsf-component-selection-invalid')
    rows = []
    for key in source:
        route = migration_path(key, source[key], target[key])
        unknown_runtime = key == 'dsh_context' and 'unknown' in (source[key]['version'], target[key]['version']) and any(component_for(n) == key for n in manifest['files'])
        if unknown_runtime:
            route = None
        rows.append({'id': key, 'label': DEFINITIONS[key][0], 'source': source[key], 'target': target[key],
                     'selected': key in selected, 'status': 'runtime-check-required' if unknown_runtime else 'compatible' if route == [] else 'migration-required',
                     'canRestore': route is not None, 'migrations': [m[1][0] for m in route] if route is not None else [],
                     'reason': '需要先检测并核对 DSH 运行时与日志格式，不影响其他组件恢复' if unknown_runtime else '' if route is not None else '需要对应组件的迁移器；尚未注册，不影响其他组件恢复'})
    dependencies = []
    pair = {'dsh_context', 'bridge_state'}
    if bool(pair & set(selected)) and (not pair.issubset(source) or not pair.issubset(selected)):
        dependencies.append('DSH 上下文与桥接会话映射需成组恢复，避免游标和会话身份错配')
    return {'creatorAppVersion': manifest.get('appVersion'), 'containerVersion': manifest['schemaVersion'],
            'selected': selected, 'components': rows, 'dependencies': dependencies,
            'canRestore': not dependencies and all(r['canRestore'] for r in rows if r['selected'])}


def apply_migrations(manifest, root, selected, stage):
    report = compatibility(manifest, root, selected)
    if not report['canRestore']: raise ValueError('dsf-component-migration-required')
    for row in report['components']:
        if not row['selected']: continue
        route = migration_path(row['id'], row['source'], row['target'])
        for _key, (_name, migrate) in route:
            try: migrate(stage)
            except Exception: raise ValueError('dsf-component-migration-failed') from None
    return report


for _component, (_label, _format, _version) in DEFINITIONS.items():
    if _component != 'dsh_context':
        register_migration(_component, _format, 0, _format, 1, 'legacy-v1-component-metadata', lambda _stage: None)
