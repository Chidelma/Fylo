const TITLE = 'Concepts — FYLO'
document.title = TITLE

export default class {
    keyCode = `name/f/alice/4UUB32VGUDW      # forward prefix   — LIKE 'ali%'
name/r/ecila/4UUB32VGUDW      # reversed prefix  — LIKE '%ice'
age/n/c03e000000000000/4UUB…  # sortable numeric — range queries
age/nr/3fc1ffffffffffff/4UUB… # reversed numeric
role/eq/admin/4UUB32VGUDW     # exact match
bio/g3/eng/4UUB32VGUDW        # trigram          — LIKE '%eng%'`

    generationCode = `const status = await fylo.recoveryStatus('posts')
// { collection: 'posts', generation: 7, state: 'stable', activity: { ... } }`
}
