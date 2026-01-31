#!/usr/bin/env node

import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import id from 'hypercore-id-encoding'
import pearLink from 'pear-link'
import { flag, command } from 'paparam'

const app = command('pear-prerelease',
  flag('--dry-run'),
  flag('--from|-f <link>'),
  flag('--to|-t <link>'),
  flag('--production|-p <link>'),
  flag('--bootstrap'),
  flag('--touch'),
  flag('--storage|-s <storage>')
).parse()

const exit = global.Bare ? Bare.exit.bind(Bare) : process.exit.bind(process)
if (!app) exit(0)

const DRY_RUN = app.flags.dryRun
const BOOTSTRAP = app.flags.bootstrap
const FROM = app.flags.from ? pearLink.parse(app.flags.from) : null
const TO = app.flags.to ? pearLink.parse(app.flags.to) : null
const PROD = app.flags.production ? pearLink.parse(app.flags.production) : null

const store = new Corestore(app.flags.storage || './corestore')

if (app.flags.touch) {
  const core = store.get({ name: Math.random() + '.' + Date.now() })
  await core.ready()
  console.log('pear://' + core.id)
  await core.close()
}

if (FROM && TO && PROD) {
  const swarm = new Hyperswarm({
    keyPair: await store.createKeyPair('hyperswarm')
  })

  swarm.on('connection', c => store.replicate(c))

  const to = new Hyperdrive(store.namespace('release'), TO.drive.key, { compat: false })
  await to.ready()

  if (!to.core.writable) {
    throw new Error('--to must be a writable drive')
  }

  const prod = new Hyperdrive(store.namespace('prod'), PROD.drive.key)
  await prod.ready()

  const from = new Hyperdrive(store.session(), FROM.drive.key)
  await from.ready()

  swarm.join(to.discoveryKey, {
    client: true,
    server: true
  })
  swarm.join(from.discoveryKey, {
    client: true,
    server: false
  })

  // hydrate prod target
  if (prod.core.length === 0 && !BOOTSTRAP && PROD.drive.length !== 0) {
    await new Promise(resolve => prod.core.once('append', () => resolve()))
  }

  prod.core.download()

  const diff = '(' + to.core.length + '/' + prod.core.length + ')'
  console.log('Copying in existing metadata data, might take a bit... ' + diff)
  while (to.core.length < prod.core.length) {
    await to.core.append(await prod.core.get(to.core.length))
    console.log('Copied blocks', to.core.length, '/', prod.core.length)
  }
  console.log('Done!')
  console.log()

  await to.getBlobs()
  if (prod.core.length > 0) {
    await prod.getBlobs()
    prod.blobs.core.download()

    const diff = '(' + to.blobs.core.length + '/' + prod.blobs.core.length + ')'
    console.log('Copying in existing blob data, might take a bit... ' + diff)
    while (to.blobs.core.length < prod.blobs.core.length) {
      await to.blobs.core.append(await prod.blobs.core.get(to.blobs.core.length))
      console.log('Copied blob blocks', to.blobs.core.length, '/', prod.blobs.core.length)
    }
    console.log('Done!')
    console.log()
  }

  const co = from.checkout(FROM.drive.length || from.core.length)
  await co.ready()

  let n = 0

  console.log('Checking diff')
  for await (const data of co.mirror(to, { dryRun: true, batch: true })) print(data)
  if (!n) console.log('(Empty)')
  console.log('Done!')
  console.log()

  const pkg = JSON.parse(await co.get('/package.json'))
  console.log('Total changes', n)
  console.log('Package version:', pkg.version)
  console.log()

  console.log('Core:')
  console.log(to.core.id, to.core.length)
  console.log(id.encode(await to.core.treeHash()))
  console.log()
  console.log('Blobs:')
  console.log(to.blobs.core.id, to.blobs.core.length)
  console.log(id.encode(await to.blobs.core.treeHash()))
  console.log()

  if (DRY_RUN) {
    console.log('Exiting due to dry run...')
    await swarm.destroy()
    exit(0)
  }

  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    console.log('Version does not look like a release version to for dry-running...')
    await swarm.destroy()
    exit(0)
  }

  console.log('NOT A DRY RUN! Waiting 10s in case you wanna bail...')
  await new Promise(resolve => setTimeout(resolve, 10_000))
  console.log('OK THEN! Staging...')

  console.log()
  for await (const data of co.mirror(to, { batch: true })) print(data)
  if (!n) console.log('(Empty)')
  console.log()

  // skipping release as thats non sensical
  const keys = ['manifest', 'metadata', 'channel', 'platformVersion', 'warmup']

  for (const k of keys) {
    const src = await co.db.get(k)
    const dst = await to.db.get(k)

    if (!src && !dst) {
      continue
    }

    if (!src && dst) {
      console.log('Dropping pear setting', k)
      await dst.db.del(k)
      continue
    }

    if ((src && !dst) || (JSON.stringify(src.value) !== JSON.stringify(dst.value))) {
      console.log('Updating pear setting', k)
      await to.db.put(k, src.value)
    }
  }

  if (await to.db.get('release')) {
    console.log('Dropping release from target...')
    await to.db.del('release')
  }

  console.log('Done!')
  console.log(to.core)
  console.log()
  console.log('Swarming until you exit...')

  let timeout = setTimeout(teardown, 15_000)
  const blobs = await to.getBlobs()

  to.core.on('upload', function () {
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
    await to.close()
  }
}
