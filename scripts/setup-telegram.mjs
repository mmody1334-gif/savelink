#!/usr/bin/env node
/**
 * Registers the Telegram webhook using values from .dev.vars (or the shell env).
 *
 *   npm run tg:setup
 *   npm run tg:delete
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const deleteMode = args.includes('--delete')

function loadDotEnv() {
  const file = resolve(process.cwd(), '.dev.vars')
  const values = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    values[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
  }
  return values
}

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

const env = { ...loadDotEnv(), ...process.env }
const token = env.BOT_TOKEN
const secret = env.WEBHOOK_SECRET
const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')

if (!token) fail('BOT_TOKEN is missing. Add it to .dev.vars or export it.')
if (!deleteMode && !secret) fail('WEBHOOK_SECRET is missing. Add it to .dev.vars or export it.')
if (!deleteMode && !base) fail('PUBLIC_BASE_URL is missing. Add it to .dev.vars or export it.')

const method = deleteMode ? 'deleteWebhook' : 'setWebhook'
const payload = deleteMode
  ? { drop_pending_updates: true }
  : {
      url: `${base}/telegram/webhook/${secret}`,
      secret_token: secret,
      allowed_updates: ['message', 'channel_post', 'callback_query', 'inline_query'],
      drop_pending_updates: true,
      max_connections: 40,
    }

const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
const result = await response.json()
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)

if (deleteMode) {
  console.log('\n✓ Webhook removed.')
  process.exit(0)
}

const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()
if (me.ok) {
  console.log(`\n✓ Webhook set to ${payload.url}`)
  console.log(`✓ Bot ready: https://t.me/${me.result.username}`)
  console.log(`\nTip: add BOT_USERNAME=${me.result.username} to [vars] in wrangler.toml so it is documented.`)
}

/** Command lists + descriptions, so the bot looks finished in Telegram's UI. */
const EN_COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'How to use SaveLink' },
  { command: 'mp4', description: 'Download a video (send a link)' },
  { command: 'mp3', description: 'Download audio (send a link)' },
  { command: 'dp', description: 'Instagram profile picture' },
  { command: 'photos', description: 'Instagram profile photos' },
  { command: 'story', description: 'Instagram active stories' },
  { command: 'highlights', description: 'Instagram highlights' },
  { command: 'id', description: 'Show this chat id' },
]

const AR_COMMANDS = [
  { command: 'start', description: 'بدء استخدام البوت' },
  { command: 'help', description: 'طريقة الاستخدام' },
  { command: 'mp4', description: 'تنزيل فيديو (أرسل الرابط)' },
  { command: 'mp3', description: 'تنزيل صوت (أرسل الرابط)' },
  { command: 'dp', description: 'صورة حساب إنستغرام' },
  { command: 'photos', description: 'صور حساب إنستغرام' },
  { command: 'story', description: 'ستوري إنستغرام النشط' },
  { command: 'highlights', description: 'هايلايتس إنستغرام' },
  { command: 'id', description: 'معرف المحادثة' },
]

async function botApi(method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await response.json()
    if (!json.ok) console.warn(`! ${method}: ${json.description ?? response.status}`)
    return json
  } catch (error) {
    console.warn(`! ${method}: ${error.message}`)
    return null
  }
}

if (!deleteMode) {
  await botApi('setMyCommands', { commands: EN_COMMANDS })
  await botApi('setMyCommands', { commands: AR_COMMANDS, language_code: 'ar' })
  await botApi('setMyShortDescription', {
    short_description: 'TikTok · Instagram · Facebook · Pinterest → MP4/MP3, plus Instagram profile photos.',
  })
  await botApi('setMyShortDescription', {
    short_description: 'حوّل روابط تيك توك وإنستغرام وفيسبوك وبينترست إلى MP4 أو MP3، ونزّل صور حسابات إنستغرام.',
    language_code: 'ar',
  })
  await botApi('setMyDescription', {
    description:
      'Send a public link and pick a format.\n\n' +
      '• /mp4 <link> — video\n' +
      '• /mp3 <link> — audio\n' +
      '• /dp @user — Instagram profile picture\n' +
      '• /photos @user — latest Instagram photos\n' +
      '• /story @user — active Instagram stories\n' +
      '• /highlights @user — Instagram highlights\n\n' +
      'Only download content you own or have permission to use.',
  })
  await botApi('setMyDescription', {
    description:
      'أرسل رابطاً عاماً واختر الصيغة.\n\n' +
      '• /mp4 رابط — فيديو\n' +
      '• /mp3 رابط — صوت\n' +
      '• /dp @user — صورة حساب إنستغرام\n' +
      '• /photos @user — آخر صور حساب إنستغرام\n' +
      '• /story @user — ستوري إنستغرام النشط\n' +
      '• /highlights @user — هايلايتس إنستغرام\n\n' +
      'نزّل فقط ما تملك حق استخدامه.',
    language_code: 'ar',
  })
  console.log('✓ Commands and descriptions registered (ar + en)')
}
