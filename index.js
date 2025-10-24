#!/usr/bin/env node

import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import id from 'hypercore-id-encoding'

const DRY_RUN = process.argv.includes('--dry-run')
const STAGE_KEY = process.argv[2]
const STAGE_CHECKOUT = Number(process.argv[3])

const PROD_KEY = process.argv[4]

const store = new Corestore('./corestore')
const swarm = new Hyperswarm({
  keyPair: await store.createKeyPair('hyperswarm')
})

const drive = new Hyperdrive(store.namespace('release'), { compat: false })
await drive.ready()

const prod = new Hyperdrive(store.namespace('prod'), PROD_KEY)
await prod.ready()

const stage = new Hyperdrive(store.session(), STAGE_KEY)
await stage.ready()

swarm.on('connection', c => store.replicate(c))
swarm.join(drive.discoveryKey, {
  client: true,
  server: true
})
swarm.join(stage.discoveryKey, {
  client: true,
  server: false
})

// hydrate prod target
if (prod.core.length === 0) await new Promise(resolve => prod.core.once('append', () => resolve()))

prod.core.download()

console.log('Copying in existing metadata data, might take a bit...')
while (drive.core.length < prod.core.length) {
  await drive.core.append(await prod.core.get(drive.core.length))
  console.log('Copied blocks', drive.core.length, '/', prod.core.length)
}
console.log('Done!')
console.log()

await drive.getBlobs()
await prod.getBlobs()

prod.blobs.core.download()

console.log('Copying in existing blob data, might take a bit...')
while (drive.blobs.core.length < prod.blobs.core.length) {
  await drive.blobs.core.append(await prod.blobs.core.get(drive.blobs.core.length))
  console.log('Copied blob blocks', drive.blobs.core.length, '/', prod.blobs.core.length)
}
console.log('Done!')
console.log()

const co = stage.checkout(STAGE_CHECKOUT)
await co.ready()

let n = 0

console.log('Checking diff')
for await (const data of co.mirror(drive, { dryRun: true, batch: true })) print(data)
if (!n) console.log('(Empty)')
console.log('Done!')
console.log()

const pkg = JSON.parse(await co.get('/package.json'))
console.log('Total changes', n)
console.log('Package version:', pkg.version)
console.log()

console.log('Core:')
console.log(drive.core.id, drive.core.length)
console.log(id.encode(await drive.core.treeHash()))
console.log()
console.log('Blobs:')
console.log(drive.blobs.core.id, drive.blobs.core.length)
console.log(id.encode(await drive.blobs.core.treeHash()))
console.log()

if (DRY_RUN) {
  console.log('Exiting due to dry run...')
  await swarm.destroy()
  process.exit(0)
}

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.log('Version does not look like a release version to for dry-running...')
  await swarm.destroy()
  process.exit(0)
}

console.log('NOT A DRY RUN! Waiting 10s in case you wanna bail...')
await new Promise(resolve => setTimeout(resolve, 10_000))
console.log('OK THEN! Staging...')

console.log()
for await (const data of co.mirror(drive, { batch: true })) print(data)
if (!n) console.log('(Empty)')
console.log()

// skipping release as thats non sensical
const keys = ['metadata', 'channel', 'platformVersion', 'warmup']

for (const k of keys) {
  const from = await co.db.get(k)
  const to = await stage.db.get(k)

  if (!from && !to) {
    continue
  }

  if (!from && to) {
    console.log('Dropping pear setting', key)
    await stage.db.del(k)
    continue
  }

  if ((from && !to) || (JSON.stringify(from.value) !== JSON.stringify(to.value))) {
    console.log('Updating pear setting', key)
    await stage.db.put(key, from.value)
  }
}

console.log('Done!')
console.log(drive.core)
console.log()
console.log('Swarming until you exit...')

let timeout = setTimeout(teardown, 15_000)
const blobs = await drive.getBlobs()

drive.core.on('upload', function () {
  clearTimeout(timeout)
  timeout = setTimeout(teardown, 15_000)
})

blobs.core.on('upload', function () {
  clearTimeout(timeout)
  timeout = setTimeout(teardown, 15_000)
})

function print (data) {
  n++
  console.log(data.op === 'add' ? '+' : data.op === 'remove' ? '-' : '~', data.key, [data.bytesAdded, -data.bytesRemoved])
}

async function teardown () {
  console.log('Shutting down due to inactivity...')
  await swarm.destroy()
  await drive.close()
}
