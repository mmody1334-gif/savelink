# كيف تعمل أدوات تنزيل صورة بروفايل إنستغرام — وهندسة نسختنا

> مرجع تعليمي (Reverse Engineering) + توثيق للميزة داخل SaveLink.
> كل الأرقام والحالات (200 / 403 / 404 / 429) في هذا الملف نتائج اختبار حقيقي، لا تخمين.

---

## 1) أول تصحيح مهم: هذه الأدوات ليست «تنزيل كل المنشورات»

الروابط الثلاثة التي ذكرتها تفعل شيئاً واحداً فقط: **تنزيل صورة البروفايل (DP)**.

| المصدر | ما يقدّمه فعلاً |
| --- | --- |
| `save-free.com/en/profile-downloader-2` | صورة البروفايل فقط (عادي / HD) |
| `instasaver.io/en/dp` | صورة البروفايل فقط، وتصفها «full resolution» |
| `AndroidWithRossyn/Instagram-HD-Profile-Downloader` | تطبيق أندرويد لصورة البروفايل «normal و HD» |

لا يوجد في أيٍّ منها زر «كل المنشورات». الميزة الثانية (ألبوم صور الحساب) أضفناها نحن، وهي تعمل بتقنية مختلفة سنشرحها.

الفرق بين الميزتين من ناحية الهندسة:

| | صورة البروفايل | منشورات/صور الحساب |
| --- | --- | --- |
| تحتاج حساباً؟ | لا (لكن بدقة منخفضة) أو نعم (لدقة كاملة) | لا للمنشورات الظاهرة في الـ embed، نعم للأرشيف |
| عدد العناصر | 1 | 6–17 بلا تسجيل دخول |
| المصدر | `/{user}/embed/` | `/{user}/embed/` (حقل `display_url` لكل منشور) |

---

## 2) المنهجية: كيف تُهندس أداة كهذه عكسياً

أي «Downloader» من هذا النوع هو مجرد **ثلاث خطوات**:

```
رابط أو اسم مستخدم
      │  ① استخراج username من المسار
      ▼
طلب إلى endpoint عام في إنستغرام
      │  ② قراءة حقل profile_pic_url من الرد
      ▼
طلب إلى CDN الصور (scontent / instagram.f*.fbcdn.net)
      │  ③ تمرير البايتات للمستخدم
      ▼
ملف JPEG
```

كل التعقيد في الخطوة ②: أي endpoint يقبل الطلب بدون تسجيل دخول في 2026؟

### خريطة نقاط النهاية كما اختبرناها

| Endpoint | الطلب | النتيجة الحقيقية | الاستنتاج |
| --- | --- | --- | --- |
| `www.instagram.com/{user}/embed/` | `UA: iPhone` | **200** + `profile_pic_url` + `full_name` + `followers_count` + `posts_count` + آخر 6–17 منشوراً | ✅ هذا هو المصدر الوحيد العام |
| `www.instagram.com/{user}/` (صفحة كاملة) | `UA: iPhone` | 200 لكن بلا `profile_pic_url`؛ `og:image` هو نفسه رابط 150×150 | ❌ لا فائدة إضافية |
| `api/v1/users/web_profile_info/?username=` | `x-ig-app-id` + UA | **404** (صفحة HTML) | ❌ أصبح يتطلب جلسة |
| `i.instagram.com/api/v1/users/{id}/info/` | UA تطبيق أندرويد | **403** `{"status":"fail"}` | ❌ مغلق |
| `i.instagram.com/api/v1/users/{user}/usernameinfo/` | UA تطبيق أندرويد | **403** | ❌ مغلق |
| `?__a=1&__d=dis` | UA سطح مكتب | **400** `SecFetch Policy violation` | ❌ مغلق |
| `?__a=1&__d=dis` + كل ترويسات المتصفح | UA سطح مكتب | **201** بجسم فارغ | ❌ مغلق |
| `p/{shortcode}/media/?size=l` | UA سطح مكتب | **200** `image/jpeg` من شبكة منزلية، لكن **HTML** (صفحة دخول، 508 KB) من شبكة Cloudflare | ⚠️ محجوب حسب عنوان IP — لا يصلح للإنتاج |
| `"display_url"` داخل الـ embed | أي UA | **200** `image/jpeg` حتى من Cloudflare (117 KB، 1080×1920) | ✅ هذا هو المصدر الذي نستخدمه |
| `graphql/query/?query_hash=d4d88dc…` | UA جوال | **401** `require_login: true` | ❌ يتطلب جلسة |
| `api/v1/users/web_profile_info/` مع كثرة الطلبات | — | **429** | ⚠️ حدّ معدل صارم |

> الدرس العملي: الأدوات التجارية التي تَعِد بـ «HD» لا تملك سراً سحرياً. إما أنها تقرأ نفس صورة 150×150 وتسمّيها HD، أو تستخدم **حسابات مسجّلة دخول** (cookie farms) للوصول إلى `profile_pic_url_hd`.

---

## 3) تشريح رابط CDN: لماذا لا يمكن تكبير الصورة بتغيير رقم؟

الصورة التي يعيدها الـ embed تبدو هكذا:

```
https://scontent.cdninstagram.com/v/t51.82787-19/625379766_1834….jpg
  ?stp=dst-jpg_s150x150_tt6      ← حجم التحويل المطلوب (150×150)
  &_nc_cat=110
  &ig_cache_key=GLaJRiUt97At…    ← مفتاح يربط الصورة بالنسخة المطلوبة
  &ccb=7-5
  &_nc_sid=669407
  &efg=eyJ2ZW5jb2RlX3RhZyI6…      ← {"vencode_tag":"profile_pic.www.1080.C3"}
  &_nc_ohc=…&_nc_oc=…
  &oh=00_AQR8BT_BBSpv3DY9XeUi…    ← توقيع HMAC على كل ما سبق
  &oe=6AF461FC                    ← تاريخ انتهاء الصلاحية (hex timestamp)
```

خدعة «غيّر `s150x150` إلى `s1080x1080`» التي تشرحها معظم المدونات **لم تعد تعمل**:

| التجربة | النتيجة |
| --- | --- |
| الرابط كما هو | 200، 150×150، ~2.2 KB |
| `s150x150` → `s1080x1080` | **403** |
| `s150x150` → `s640x640` | **403** |
| `s150x150` → `s320x320` | **403** |
| حذف `stp` بالكامل | **403** |

السبب: الحقل `oh` هو توقيع يُحسب على **كل** الـ query string، بما فيها `stp`. تغيير أي حرف يُبطل التوقيع فترفضه الـ CDN. هذا بالضبط ما يجعل `profile_pic_url_hd` (رابط موقّع آخر بحجم أكبر) ذا قيمة: تحتاج أن يوقّعه إنستغرام لك.

**الحالة الوحيدة التي نحصل فيها على HD**: أن يوقّع إنستغرام رابطاً بحجم كامل، وهذا يحدث فقط داخل جلسة مسجّلة عبر `web_profile_info` → الحقل `profile_pic_url_hd`. لذلك نسخة SaveLink تستخدم `IG_COOKIE` كترقية اختيارية.

---

## 4) كيف نزّلنا «صور الحساب» بلا تسجيل دخول

جرّبنا طريقين، وأحدهم سقط في الإنتاج:

### الطريق الأول (فشل): `/p/<shortcode>/media/?size=l`

```
GET https://www.instagram.com/p/<shortcode>/media/?size=l
```

- من شبكة منزلية: **200** `image/jpeg` بالصورة الأصلية (1080×1350، 1080×1920…).
- من شبكة Cloudflare (عنوان مركز بيانات): **200** لكن `text/html` بحجم ~508 KB، وأول بايتين `3c 21` أي `<!`. إنها صفحة تسجيل الدخول، لا صورة.
- جرّبنا معها UA سطح مكتب/جوال، مع وبدون `Referer` — النتيجة نفسها دائماً.

الدرس: نجاح endpoint من جهازك لا يعني نجاحه من السيرفر. لذلك لا يمكن الاعتماد عليه في Worker.

### الطريق الثاني (المستخدم): حقل `display_url` داخل الـ embed

الـ embed نفسه يحمل لكل منشور رابط CDN موقّعاً بحجم كامل:

```json
"shortcode":"DfT4cjxF_b3",
"is_video":false,
"display_url":"https://instagram.f…fbcdn.net/v/…jpg?stp=dst-jpg_e15_tt6&…oh=…"
```

- **200** `image/jpeg` حتى من شبكة Cloudflare، بدون UA خاص وبدون `Referer`.
- الأبعاد التي تحققنا منها: **1080×1920** (الصورة الأصلية كما رفعها صاحب الحساب).
- الرابط موقّع بمفتاح `oh`، لذا لا نحاول تغيير `stp` أو أي معامل آخر.

الاستخراج الذي نستخدمه في `fetchProfileEmbed()`:

1. `decodeEscapes()` لإزالة كل طبقات `\"` و `\/` و `\u0026` (إنستغرام يهرّب JSON مرتين).
2. نقسم النص على `"shortcode":"` — كل قطعة تبدأ بمنشور واحد وتبقى حقوله بجانبه.
3. من كل قطعة نقرأ `"display_url"` و `"is_video"`، ونتجاهل أي shortcode مكرر.
4. النتيجة ثلاث مصفوفات متوازية دائماً: `recentShortcodes` / `recentDisplayUrls` / `videoFlags`.
5. `/"profile_pic_url":"([^"]+)"/` لصورة البروفايل، ثم `followers_count` و`posts_count` و`full_name` للبيانات الوصفية.

> لماذا لا نستخدم `matchAll` ثلاث مرات بشكل منفصل؟ لأن أي منشور بلا `display_url` (أو فيديو) كان سيُزيح الترتيب: صورة تُنسب لمنشور آخر. التقسيم على الـ shortcode يضمن أن كل رابط يبقى مع صاحبه.

> ملاحظة تقنية: `JSON.parse` المباشر يفشل هنا لأن الصفحة تحتوي JSON مُهرَّباً داخل سلسلة داخل `<script>`. لذلك نستخدم regex على النص بعد فك التهريب — وهو نفس الأسلوب الذي تتبعه الأدوات المفتوحة المصدر.

### لماذا «6–17 منشوراً» فقط؟

الـ embed يعرض فقط آخر المنشورات التي يحتاجها لتوليد بطاقة المعاينة. لا يوجد `end_cursor` ولا `has_next_page` في هذا الرد (تحققنا: الحقول غير موجودة). الأرشيف الكامل يحتاج جلسة، عبر نقطتين:

```
GET https://i.instagram.com/api/v1/users/web_profile_info/?username=<user>
   → user.id + أول edges + page_info.end_cursor

GET https://i.instagram.com/api/v1/feed/user/{user_id}/?count=17&max_id=<cursor>
   → items[] + next_max_id + more_available
Cookie: sessionid=…
```

وهذه النقاط ترجع **403/401** بلا جلسة، وهو سبب أن أي أداة «تنزيل كل منشورات حساب» تحتاج حساباً.

### الستوري والهايلايتس (نفس الشرط)

```
GET https://i.instagram.com/api/v1/feed/reels_media/?reel_ids={user_id}
GET https://i.instagram.com/api/v1/highlights/{user_id}/highlights_tray/
Cookie: sessionid=…
```

- الستوري: `reels_media` يعيد `items[]`، وكل عنصر إما `media_type=1` (صورة في `image_versions2.candidates[0].url`) أو `media_type=2` (فيديو في `video_versions[0].url`).
- الهايلايتس: `tray[]` يعيد `{id, title, media_count}`، وكل `id` يُقرأ بنفس `reels_media` بكلمة `highlight:…`.
- كلاهما يُرسل بحد أقصى **12 عنصراً** في المرة (ألبوم صور ≤10 + فيديوهات منفردة) لتجنّب حدود تيليجرام وحد الـ subrequests.


---

## 5) ما الذي بنيناه في هذا المشروع

### المسار الكامل داخل البوت

```
المستخدم يرسل: https://instagram.com/natgeo/   أو   @natgeo
        │
        ▼
parseInstagramProfile()        src/platforms.ts
   • يرفض /p/ /reel/ /reels/ /tv/ /stories/ /explore/ /accounts/ /share/
   • يقبل فقط مساراً واحداً صالحاً كاسم مستخدم
        │
        ▼
resolveInstagramProfile()      src/instagram-profile.ts
   • fetchProfileEmbed()            → الصورة + الاسم + المتابعون + display_url لكل منشور
   • upgradeProfileWithCookie()     → إن وُجد IG_COOKIE: profile_pic_url_hd
   • photoItem(displayUrl)          → رابط CDN الموقّع من الـ embed
        │
        ▼
handleProfile()                src/telegram/webhook.ts
   • رسالة تلخيص + أزرار:
       [🖼 صورة الحساب · 150×150]
       [📥 صور الحساب (8)]
       [🔗 تنزيل مباشر]
        │
        ▼
sendAlbum()                    src/telegram/send.ts
   • تنزيل كل صورة عبر Worker ثم رفعها كـ sendMediaGroup (ألبوم ≤10 صور)
   • فشل الألبوم → إرسال فردي كخطة بديلة
```

### مسار الأرشيف والستوري والهايلايتس

```
handleArchive()                src/telegram/webhook.ts
   • fetchArchivePage()          src/instagram-profile.ts
       web_profile_info (أول مرة) → edges + end_cursor
       feed/user/{id}?max_id=…    (الضغطات التالية) → items + next_max_id
   • sendAlbum(17 صورة) ثم زر «⬇️ المزيد» (callback A|key|1)

showStories() / showHighlights()  src/telegram/webhook.ts
   • fetchActiveStories() / fetchHighlights() / fetchHighlightItems()
                                  src/instagram-stories.ts
       resolveUserId() → web_profile_info
       feed/reels_media?reel_ids=…  (الستوري أو highlight:…)
       highlights/{id}/highlights_tray/
   • sendReel(): ألبوم صور ≤10 + فيديوهات منفردة، بحد 12 عنصراً
```

### أوامر البوت الجديدة

| الأمر | الوظيفة |
| --- | --- |
| `/dp @user` أو `/dp <رابط>` | صورة البروفايل فقط |
| `/photos @user` | صورة البروفايل + آخر صور الحساب |
| `/profile @user` | مثل `/photos` |
| `/story @user` | الستوري النشط (يحتاج `IG_COOKIE`) |
| `/highlights @user` | قائمة الهايلايتس ثم اختيار واحد (يحتاج `IG_COOKIE`) |
| زر «📚 كل المنشورات» | 17 صورة في كل ضغطة + «⬇️ المزيد» حتى نهاية الأرشيف |
| `@user` وحده في رسالة | يعامله كطلب صورة بروفايل |

### متغيرات البيئة

| المتغير | الافتراضي | المعنى |
| --- | --- | --- |
| `PROFILE_MAX_ITEMS` | `30` | أقصى عدد صور في الطلب (حد أقصى 30، والألبوم 10 لكل رسالة) |
| `IG_COOKIE` | فارغ | `sessionid=…; ds_user_id=…` لترقية الصورة إلى HD، والحسابات الخاصة، والأرشيف، والستوري، والهايلايتس |

### الحدود التي يجب أن تكون واضحة للمستخدم

1. **بلا `IG_COOKIE`**: الصورة 150×150 حصراً. هذا حدّ إنستغرام لا حدّ البوت.
2. **بلا `IG_COOKIE`**: 6–17 منشوراً حديثاً فقط (ما يعرضه الـ embed)، ولا ستوري ولا هايلايتس.
3. **الحسابات الخاصة**: لا تظهر في الـ embed إطلاقاً → رسالة «حساب خاص أو غير موجود».
4. **الحدّ الأقصى**: 10 صور لكل ألبوم (قيد تيليجرام)، و`PROFILE_MAX_ITEMS` يحدد الإجمالي (الافتراضي 30 = كل ما يعرضه الـ embed).
5. **الأرشيف**: 17 صورة في كل ضغطة (17 تنزيلاً + ألبومان ≈ 19 subrequest، تحت حد Cloudflare 50)، ويستمر حتى `more_available=false`.
6. **الستوري**: آخر 24 ساعة فقط، وبحد 12 عنصراً في المرة.
7. **الهايلايتس**: تُعرض أول 25 مجموعة كأزرار، وكل مجموعة بحد 12 عنصراً.

---

## 6) كيف تضيف الدقة الكاملة (HD) والأرشيف والستوري

1. سجّل الدخول إلى إنستغرام في متصفح سطح مكتب.
2. **تحقق أن الجلسة حيّة**: افتح
   `https://www.instagram.com/api/v1/accounts/current_user/?edit=true`
   - JSON فيه `"user"` ← الجلسة سليمة.
   - إعادة توجيه للصفحة الرئيسية ← سجّل الدخول من جديد.
3. DevTools → Network → أعد تحميل الصفحة → طلب `current_user` → Headers →
   انسخ **قيمة `cookie:` كاملة**.
4. ضعها في `.dev.vars` (محلي فقط):
   ```
   IG_COOKIE="sessionid=...; ds_user_id=...; csrftoken=...; mid=...; ..."
   ```
5. اختبر محلياً **قبل** رفعه:
   ```powershell
   npm run cookie:check -- حسابك
   ```
   المتوقع `OK: session VALID`. إن ظهر `FAIL` فالكوكي قديم/ناقص.
6. ارفعه للـ Worker:
   ```powershell
   npx wrangler secret put IG_COOKIE
   ```
7. أعد النشر، ثم `/photos @user` → ستظهر أزرار الأرشيف والستوري والهايلايتس.

### تشخيص: الكوكي سليم محلياً لكن الـ Worker يفشل

إن نجح `npm run cookie:check` وفشل الـ Worker بـ **403/404**، فغالباً إنستغرام يحجب
عناوين Cloudflare (datacenter IP) عن واجهات `/api/v1` الخاصة. الحل الوحيد هو مخرج
بـ IP سكني:

- **Cloudflare Tunnel** على جهازك: سيرفر Node صغير يمرّر الطلبات مع الكوكي،
  يعمل ما دام الجهاز مفتوحاً، ومجاناً.
- أو بروكسي سكني مدفوع (Residential proxy).

> ملاحظة مؤكدة من الاختبار: الـ embed العام (`/{user}/embed/`) يعمل من Cloudflare
> دائماً؛ المحجوب هو الواجهات الخاصة فقط (الأرشيف/الستوري/الهايلايتس).

> لا تضع الكوكي في `wrangler.toml` أو في Git. الجلسة تمنح وصولاً كاملاً للحساب، وتنتهي صلاحيتها كل فترة.

---

## 7) الأخلاقيات والحدود القانونية (مهم)

- صورة البروفايل **بيانات شخصية**. تنزيلها لنفسك أو لعائلتك بموافقة صاحبها أمر طبيعي؛ إعادة نشرها أو استخدامها في محتوى دون إذن قد يخالف قوانين حماية البيانات وحقوق الصورة.
- الحسابات الخاصة: تجاوز الخصوصية باستخدام cookie شخص آخر قد يخالف شروط إنستغرام وقوانين القرصنة.
- احترم معدل الطلبات: نقطة `web_profile_info` ترجع **429** بسرعة. البوت يحدّ الطلبات لكل مستخدم (`RATE_LIMIT_PER_MIN`).
- إنستغرام يغيّر هذه الواجهات بلا إشعار. اعتبر أي extractor «قابلاً للكسر»، ولهذا بُني المشروع بسلسلة محركات واحتياطي yt-dlp.

---

## 8) تمارين للتعلّم (أعد التجربة بنفسك)

```powershell
# 1) هل الـ embed يعمل من جهازك؟
curl.exe -s -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15" `
  "https://www.instagram.com/natgeo/embed/" | Select-String "profile_pic_url"

# 2) هل توقيع الـ CDN يمنع تغيير الحجم؟ (توقّع 403)
curl.exe -s -o NUL -w "%{http_code}`n" "<رابط scontent مع s1080x1080 بدل s150x150>"

# 3) هل نقطة /media/ العامة تعمل من جهازك؟ (توقّع 200 image/jpeg منزلياً)
curl.exe -s -o sample.jpg -w "%{http_code} %{content_type} %{size_download}`n" `
  "https://www.instagram.com/p/<shortcode>/media/?size=l"

# 3-ب) نفس الطلب من داخل Worker/Cloudflare يعيد HTML — لذلك نستخدم display_url
#      من الـ embed، وهو يعيد 200 image/jpeg من الشبكتين.

# 4) هل web_profile_info متاح بلا جلسة؟ (توقّع 404)
curl.exe -s -o NUL -w "%{http_code}`n" `
  -H "x-ig-app-id: 936619743392459" `
  "https://www.instagram.com/api/v1/users/web_profile_info/?username=natgeo"
```

إذا تغيّرت النتائج غداً، فأنت أمام نسخة جديدة من إنستغرام: حدّث `src/instagram-profile.ts` فقط، لأن كل بقية النظام (التوقيع، الألبومات، الحدود) مستقل عنها.
