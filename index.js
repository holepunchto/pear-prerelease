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

console.log(drive.blobs.core.length, drive.blobs.core.byteLength, id.encode(await drive.blobs.core.treeHash()))
console.log(drive.core.length, id.encode(await drive.core.treeHash()))

const stage = new Hyperdrive(store.session(), STAGE_KEY)
await stage.ready()

const co = stage.checkout(STAGE_CHECKOUT)
await co.ready()

swarm.on('connection', c => store.replicate(c))
swarm.join(drive.discoveryKey, {
  client: true,
  server: true
})
swarm.join(co.discoveryKey, {
  client: true,
  server: false
})

let n = 0

for await (const data of co.mirror(drive, { dryRun: true, batch: true })) print(data)

const pkg = JSON.parse(await co.get('/package.json'))
console.log()
console.log('total changes', n)
console.log('version:', pkg.version)
console.log()

console.log(drive.core.id, drive.core.length)
console.log(id.encode(await drive.core.treeHash()))
console.log(drive.blobs.core.length)
console.log(id.encode(await drive.blobs.core.treeHash()))

if (DRY_RUN) {
  console.log('exiting due to dry run...')
  await swarm.destroy()
  process.exit(0)
}

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.log('version does not look like a release version to for dry-running...')
  await swarm.destroy()
  process.exit(0)
}

console.log('NOT A DRY RUN! Waiting 10s in case you wanna bail...')
await new Promise(resolve => setTimeout(resolve, 10_000))
console.log('OK THEN! Staging...')

console.log()
for await (const data of co.mirror(drive, { batch: true })) print(data)
console.log()

console.log('DONE!')
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
