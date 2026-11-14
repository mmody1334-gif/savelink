# دليل تثبيت SaveLink كاملاً

> بوت تيليجرام يحوّل روابط TikTok وInstagram وFacebook وPinterest إلى MP4/MP3،
> وينزّل صورة بروفايل إنستغرام وآخر صور الحساب.
> يعمل على **Cloudflare Workers** (الخطة المجانية تكفي).

هذا الدليل مكتوب لمن يستخدم Windows، لكن الأوامر نفسها تعمل على macOS/Linux
مع استبدال `powershell` بـ `bash` ومسار `.ps1` بسكربت bash.

---

## 1) قبل أن تبدأ

| تحتاجه | لماذا | كيف تحصل عليه |
| --- | --- | --- |
| Node.js 20 أو أحدث | تشغيل wrangler والاختبارات | <https://nodejs.org> (اختر LTS) |
| حساب Cloudflare مجاني | استضافة الـ Worker | <https://dash.cloudflare.com/sign-up> |
| توكن بوت من BotFather | ربط البوت بتليجرام | افتح [@BotFather](https://t.me/BotFather) → `/newbot` → انسخ التوكن |

> التوكن يشبه `1234567890:AA...`. لا ترسله لأحد ولا تضعه في Git.

---

## 2) الطريقة السريعة (سطر واحد)

من داخل مجلد المشروع:

```powershell
cd "C:\Users\mmody\Documents\Default Project\savelink"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -BotToken "1234567890:AA..."
```

أو إذا كنت لا تريد كتابة التوكن في الأمر (يبقى في سجل الطرفية)، شغّل السكربت
بدون `-BotToken` وسيسألك عنه:

```powershell
.\scripts\install.ps1
```

### ما الذي يفعله السكربت؟

| الخطوة | ماذا يحدث |
| --- | --- |
| 1/8 | يتأكد من Node 20+ ومن تسجيل الدخول إلى Cloudflare |
| 2/8 | يتأكد من وجود KV namespace باسم `CACHE`، وينشئه ويحدّث `wrangler.toml` إن لزم |
| 3/8 | ينشئ `.dev.vars` ويولّد `WEBHOOK_SECRET` و`SIGNING_SECRET` عشوائيين |
| 4/8 | `npm install` |
| 5/8 | `tsc --noEmit` + `vitest run` (77 اختباراً) |
| 6/8 | `npx wrangler deploy` ويستخرج رابط `https://<worker>.<subdomain>.workers.dev` |
| 7/8 | يرفع الأسرار إلى Cloudflare عبر `wrangler secret bulk` |
| 8/8 | `npm run tg:setup` لتسجيل الويب هوك + أوامر البوت + وصفه بالعربية والإنجليزية |

في النهاية يطبع رابط `https://t.me/<bot>` مباشرة.

### خيارات السكربت

| الخيار | المعنى |
| --- | --- |
| `-BotToken "..."` | تمرير التوكن بدون سؤال |
| `-SkipTests` | تخطي الاختبارات (أسرع، غير مستحسن أول مرة) |
| `-LocalOnly` | تثبيت محلي فقط بدون نشر |
| `-DryRun` | عرض الخطة وفحص المتطلبات دون أي تغيير |

---

## 3) التثبيت اليدوي (إذا فضّلت الخطوات واحدة واحدة)

### 3.1 سجّل الدخول إلى Cloudflare

```powershell
npx wrangler login
```

يفتح المتصفح ويطلب الموافقة. تحقق:

```powershell
npx wrangler whoami
```

### 3.2 أنشئ ملف الأسرار

```powershell
Copy-Item .dev.vars.example .dev.vars
```

حرّر `.dev.vars` وضع فيه:

```ini
BOT_TOKEN=1234567890:AA...
WEBHOOK_SECRET=<64 حرف hex عشوائي>
SIGNING_SECRET=<64 حرف hex عشوائي>
PUBLIC_BASE_URL=https://<worker>.<subdomain>.workers.dev
```

للتوليد:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `.dev.vars` مُستثنى من Git مسبقاً. لا ترفعه.

### 3.3 ثبّت التبعيات واختبر

```powershell
npm install
npm run typecheck
npm test
```

### 3.4 أنشئ KV namespace (حالة دائمة)

```powershell
npx wrangler kv namespace create CACHE
```

سينسخ لك السكربت:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

الصقها في `wrangler.toml` بدل `id` القديم (أو احذفها واترك السكربت يفعل ذلك).

### 3.5 انشر

```powershell
npx wrangler deploy
```

سيظهر رابط الـ Worker. ضعه في `.dev.vars` كـ `PUBLIC_BASE_URL`.

### 3.6 ارفع الأسرار

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put SIGNING_SECRET
npx wrangler secret put PUBLIC_BASE_URL
```

أو دفعة واحدة عبر ملف JSON:

```powershell
'{ "BOT_TOKEN":"...", "WEBHOOK_SECRET":"...", "SIGNING_SECRET":"...", "PUBLIC_BASE_URL":"https://..." }' |
  Set-Content secrets.json -Encoding UTF8
npx wrangler secret bulk secrets.json
Remove-Item secrets.json
```

> بعد أي تغيير في الأسرار لا حاجة لإعادة النشر.

### 3.7 سجّل الويب هوك

```powershell
npm run tg:setup
```

يسجّل `https://<worker>/telegram/webhook/<WEBHOOK_SECRET>`، ويضبط أيضاً:

- أوامر البوت: `/start /help /mp4 /mp3 /dp /photos /story /highlights /id` (عربي + إنجليزي)
- الوصف القصير والوصف الكامل للبوت

---

## 4) التحقق النهائي (قائمة اختبار)

1. **صحة الـ Worker:**

   ```powershell
   Invoke-RestMethod https://<worker>.workers.dev/api/health
   ```

   المتوقع:

   ```json
   { "ok": true, "service": "savelink", "bot": true, "store": "kv", "engines": ["native"] }
   ```

   إذا ظهر `"store":"memory"` فمعناه أن KV غير مربوط (راجع 3.4).
   وجود `native` فقط أمر طبيعي: بقية المحركات اختيارية.

2. **حالة الويب هوك:**

   ```powershell
   $t = ((Get-Content .dev.vars | Where-Object { $_ -match '^BOT_TOKEN=' }) -replace '^BOT_TOKEN=','').Trim()
   Invoke-RestMethod "https://api.telegram.org/bot$t/getWebhookInfo" |
     Select-Object url, pending_update_count, last_error_message
   ```

   المتوقع: `pending_update_count = 0` و`last_error_message` فارغ.

3. **داخل تيليجرام:**

   | الاختبار | المتوقع |
   | --- | --- |
   | افتح رابط البوت واضغط **Start** | رسالة ترحيب + الأوامر تظهر في القائمة |
   | `/id` | يعرض رقم المحادثة الخاص بك |
   | أرسل رابط TikTok عام | معاينة + أزرار `📹 1080p` و`🎵 MP3` |
   | `/photos @natgeo` | صورة الحساب + ألبوم آخر الصور |
   | `/dp @natgeo` | صورة البروفايل 150×150 (أو HD مع `IG_COOKIE`) |
   | `/story @natgeo` مع `IG_COOKIE` | ستوري الحساب النشط (ينتهي بعد 24 ساعة) |
   | `/highlights @natgeo` مع `IG_COOKIE` | قائمة الهايلايتس ثم اختر واحداً |
   | زر «📚 كل المنشورات» مع `IG_COOKIE` | 17 صورة في كل ضغطة + زر «⬇️ المزيد» حتى نهاية الأرشيف |
   | أرسل رابطاً خاصاً/محذوفاً | رسالة خطأ واضحة بالعربية |

---

## 5) الأوامر اليومية

| الأمر | الاستخدام |
| --- | --- |
| `npx wrangler deploy` | نشر تعديلات الكود |
| `npx wrangler tail` | متابعة سجلات الـ Worker الحية |
| `npm run tg:setup` | إعادة تسجيل الويب هوك (بعد تغيير الرابط أو الأسرار) |
| `npm run tg:delete` | إزالة الويب هوك (لإيقاف البوت مؤقتاً) |
| `npm run dev` | تشغيل محلي على `http://localhost:8787` |
| `npm run typecheck` | فحص TypeScript |
| `npm test` | تشغيل الاختبارات |

> للتشغيل المحلي مع تيليجرام تحتاج نفقاً عاماً:
> `cloudflared tunnel --url http://localhost:8787` ثم ضع الرابط في
> `PUBLIC_BASE_URL` وشغّل `npm run tg:setup`.

---

## 6) ترقيات اختيارية

### 6.1 صورة إنستغرام بالدقة الكاملة (HD) + الأرشيف + الستوري

بدون أي إعداد، صورة البروفايل تأتي من الـ embed العام بدقة **150×150** — هذا حدّ
إنستغرام نفسه وليس حدّ البوت. الكوكي يفتح أيضاً **الأرشيف الكامل (70+ منشوراً)**،
**الستوري النشط**، و**الهايلايتس**؛ لا توجد واجهة عامة لهذه الثلاثة.

1. سجّل الدخول إلى إنستغرام في متصفح سطح مكتب.
2. **تحقق أولاً أنك مسجّل فعلاً**: افتح في نفس المتصفح
   `https://www.instagram.com/api/v1/accounts/current_user/?edit=true`
   - إن ظهر JSON فيه `"user"` واسم حسابك ← الجلسة سليمة.
   - إن رجعت للصفحة الرئيسية أو ظهرت صفحة دخول ← سجّل الدخول من جديد.
3. DevTools → Network → أعد تحميل تلك الصفحة → اضغط طلب `current_user` →
   Headers → انسخ **قيمة `cookie:` كاملة**.
4. ضعها محلياً في `.dev.vars` (ملف محلي، لا يُرفع إلى git):

   ```
   IG_COOKIE="sessionid=...; ds_user_id=...; csrftoken=...; mid=...; ..."
   ```

5. **اختبر الكوكي من جهازك قبل رفعه**:

   ```powershell
   npm run cookie:check -- حسابك
   ```

   المتوقع: `OK: session VALID on this machine`. إن ظهر `FAIL` فالكوكي قديم/ناقص —
   أعد الخطوات، ولا ترفعه للـ Worker قبل نجاح هذا الاختبار.

6. أضف السر للـ Worker:

   ```powershell
   npx wrangler secret put IG_COOKIE
   # sessionid=...; ds_user_id=...; csrftoken=...
   ```

7. أعد نشر الـ Worker ثم أرسل `/photos @حسابك` وستظهر الأزرار:
   `📚 كل المنشورات` · `🟣 الستوري` · `✨ الهايلايتس`.

> الستوري يعرض فقط آخر 24 ساعة، ويجب أن حساب الكوكي يتابع الحساب إن كان خاصاً.
> الجلسة تمنح وصولاً كاملاً للحساب، وتنتهي صلاحيتها دورياً. استخدم حساباً
> ثانوياً إن أمكن، وراجع `docs/instagram-profile.md` للتفاصيل.

### 6.2 MP3 حقيقي لكل المنصات (yt-dlp sidecar)

Cloudflare Workers لا تستطيع تشغيل ffmpeg، لذلك تحويل الصوت يتم في خدمة صغيرة
منفصلة. حالياً المحرك `native` يعطي MP3 لتيك توك فقط (لأنه يوفّر المسار الأصلي).

```powershell
# محلياً (يتطلب Docker)
$env:YTDLP_TOKEN="change-me"
docker compose up --build

# ثم اربط الـ Worker بالـ sidecar
npx wrangler secret put YTDLP_ENDPOINT   # https://<sidecar>
npx wrangler secret put YTDLP_TOKEN      # نفس القيمة
```

استضف الـ sidecar مجاناً على Render أو Koyeb أو Fly.io (Dockerfile موجود في
`sidecar/`). إن نامت الخدمة أو تأخرت، ينتقل البوت تلقائياً إلى المحرك الاحتياطي.

### 6.3 cobalt (احتياطي ثالث)

```powershell
npx wrangler secret put COBALT_INSTANCES   # https://cobalt1.example.com,https://cobalt2.example.com
npx wrangler secret put COBALT_API_KEY     # إن كانت نسختك تتطلبه
```

> لا تستخدم `api.cobalt.tools` العام، فهو يحجب الطلبات الآلية.

---

## 7) استكشاف الأخطاء

| المشكلة | السبب والحل |
| --- | --- |
| `BOT_TOKEN is not configured` | السر لم يُرفع: `npx wrangler secret put BOT_TOKEN` |
| البوت لا يرد إطلاقاً | أعد `npm run tg:setup`، ثم `curl https://<worker>/api/health` ثم `npx wrangler tail` |
| `Unauthorized` عند النشر | `npx wrangler login` من جديد |
| `KV namespace not found` | الـ id في `wrangler.toml` يخص حساباً آخر: أنشئ namespace جديداً واستبدل الـ id |
| `store: memory` في health | KV غير مربوط؛ راجع 3.4 وأعد النشر |
| «الحساب خاص أو غير موجود» | الحساب فعلاً خاص/محذوف، أو الـ embed محجوب مؤقتاً — أعد المحاولة |
| صورة البروفايل 150×150 فقط | حد إنستغرام المجهول؛ أضف `IG_COOKIE` (6.1) |
| تصل 6–17 صورة فقط | هذا كل ما يعرضه إنستغرام للزائر غير المسجّل (الـ embed). المنشورات الأقدم لا تظهر للعامة — لا يوجد حل بدون جلسة |
| زر MP3 يقول «غير متاح» | طبيعي لغير تيك توك بدون sidecar (6.2) |
| `File too large` أو فشل الرفع | تيليجرام يحد الرفع إلى 50MB عبر Bot API؛ خفّض الجودة أو استخدم زر التنزيل المباشر |
| `429` كثيراً | ارفع `RATE_LIMIT_PER_MIN` أو أضف KV |
| الصور تصل كصفحة HTML | كان خللاً قديماً في مصدر إنستغرام؛ عولج باستخدام `display_url` من الـ embed. تأكد أنك على آخر نشر |

### سجلات سريعة

```powershell
npx wrangler tail --format pretty
```

---

## 8) الأمان والصيانة

- **لا تشارك `BOT_TOKEN`**. إذا تسرّب (لصق في محادثة، لقطة شاشة، مستودع عام):
  افتح BotFather → `/revoke` → انسخ التوكن الجديد → أعد خطوة 7.
- **لا ترفع `.dev.vars`** ولا `.dev.vars.bak`؛ كلاهما مستثنى في `.gitignore`.
- **`SIGNING_SECRET`** يوقّع روابط `/api/file`. تغييره يبطل كل الروابط القديمة
  (وهذا آمن: المستخدمون يعيدون الإرسال).
- **`WEBHOOK_SECRET`** جزء من مسار الويب هوك ويُتحقق منه في ترويسة
  `X-Telegram-Bot-Api-Secret-Token`. تغييره يتطلب `npm run tg:setup`.
- البوت لا يخزّن الوسائط: يمرّرها فقط، وروابط التنزيل تنتهي بعد ساعة.

---

## 9) ماذا بعد؟

- واجهة ويب: نفس الـ Worker يخدم `/api/resolve` و`/api/file`، يمكن بناء صفحة
  عليها لاحقاً دون تغيير الخلفية.
- مرجع الهندسة العكسية لصور إنستغرام: [`docs/instagram-profile.md`](docs/instagram-profile.md)
- نظرة عامة على المشروع والمتغيرات: [`README.md`](README.md)
