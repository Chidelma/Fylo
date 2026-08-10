const TITLE = 'Serverless queue — FYLO'
document.title = TITLE

export default class {
    layoutCode = `<root>/.fylo-queue/v1/
  manifest.json
  receipt-key.json
  topics/<encoded-topic>/<message-id>.json
  consumers/<encoded-group>/<encoded-topic>.json
  dedupe/<encoded-topic>/<sha256-key>.json
  dead-letter/<encoded-group>/<encoded-topic>/<message-id>.json`

    directCode = `const published = await db.queue.publish(
    'email.welcome',
    { userId: 'u-7' },
    { idempotencyKey: 'welcome:u-7' }
)

const deliveries = await db.queue.claim('email.welcome', 'email-service', {
    maxMessages: 10,
    visibilityTimeoutMs: 30_000,
    maxAttempts: 5
})

for (const delivery of deliveries) {
    try {
        await sendWelcomeEmail(delivery.payload)
        await db.queue.ack('email.welcome', 'email-service', delivery)
    } catch {
        await db.queue.nack('email.welcome', 'email-service', delivery, {
            delayMs: 5_000,
            reason: 'queue handler failed'
        })
    }
}`

    decoratorCode = `const consume = db.queue.consumer('email.welcome', 'email-service', {
    maxMessages: 10,
    maxAttempts: 5,
    retryDelayMs: 1_000
})(async (delivery) => {
    await sendWelcomeEmail(delivery.payload)
})

// One bounded serverless invocation; this does not poll forever.
const outcome = await consume()`

    pythonCode = `@db.queue_consumer(
    "email.welcome",
    "email-service",
    max_messages=10,
    max_attempts=5,
)
def send_welcome(delivery):
    send_welcome_email(delivery["payload"])

outcome = send_welcome()`
}
