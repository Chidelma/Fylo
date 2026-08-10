const TITLE = 'Encryption & access — FYLO'
document.title = TITLE

export default class {
    schemaCode = `{
    "$encrypted": ["ssn", "email", "payload/verifier"],
    "id": "^[0-9]+$",
    "name": "^.+$",
    "email": "^.+$",
    "ssn?": "^[0-9-]+$",
    "payload?": { "verifier?": "^.+$" }
}`

    postixCode = `const id = await db.documents.put({ title: 'private' })
    .as({ uid: 1001, mode: 0o600 })

const teamId = await db.documents.put({ title: 'team draft' })
    .as({ gid: editorsGid, mode: 0o660 })

await db.documents.get(id).as({ uid: 1001 })
await db.documents.patch(id, { title: 'updated' }).as({ uid: 1001 })
await db.documents.delete(id).as({ uid: 1001 })`

    sqlAccessCode = `const sqlId = await db.sql\`
    INSERT INTO documents (title) VALUES (\${'team draft'})
\`.as({ gid: editorsGid, mode: 0o660 })

await db.sql\`UPDATE documents SET title = \${'updated'} WHERE title = \${'team draft'}\`
    .as({ uid: 1002 })`

    actorCode = `const actor = {
    uid: authenticatedUser.uid,
    groups: await identityProvider.groupIdsFor(authenticatedUser.uid)
}

await db.messages.patch(teamId, { title: 'reviewed' }).as(actor)`
}
