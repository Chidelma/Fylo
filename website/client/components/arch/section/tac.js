export default class {
    hydrate() {}
    strategies = [
        { op: '$eq', index: 'Exact match key (eq)', example: 'role/eq.admin' },
        { op: '$gte / $lte', index: 'Sortable numeric key (n / nr)', example: 'age/n/c03e…' },
        { op: "$like 'ali%'", index: 'Forward prefix (f)', example: 'name/f/ali…' },
        { op: "$like '%ice'", index: 'Reversed prefix (r)', example: 'name/r/eci…' },
        { op: "$like '%lic%'", index: 'Trigram (g3) → hydrate → verify', example: 'name/g3/lic…' },
        { op: '$contains', index: 'Exact match on array members', example: 'tags/eq/platform' }
    ]

    treeText() {
        return [
            '<root>/.collections/users/',
            '  docs/                  ← one .json file per document',
            '    4U/',
            '      4UUB32VGUDW.json',
            '  .deleted/              ← soft-deleted payloads',
            '  index/',
            '    manifest.json        ← format version marker',
            "    keys.snapshot        ← sorted keys, mmap'd O(log n)",
            '    keys.wal             ← append-only mutation log',
            '  events/',
            '    users.ndjson         ← append-only event journal',
            '  locks/                 ← advisory file locks'
        ].join('\n')
    }
}
