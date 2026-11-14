export type Lang = 'ar' | 'en'

type Entry = { ar: string; en: string }

const strings = {
  start: {
    ar: '👋 <b>أهلاً بك في SaveLink</b>\n\nأرسل رابطاً من TikTok أو Instagram أو Facebook أو Pinterest وسأعرض لك خيارات التنزيل!\n\n🎬 <b>أفلام ومسلسلات:</b>\n• <code>/movie اسم الفيلم</code>\n• <code>/series اسم المسلسل</code>\n\n🔓 <b>تخطي الإعلانات وروابط الاختصار:</b>\n• <code>/bypass رابط</code> (أو أرسل الرابط مباشرة)\n\n🤖 <b>تفريغ وتلخيص الصوت بالذكاء الاصطناعي:</b>\n• أرسل أي تسجيل صوتي مباشرة للبوت أو رد عليه بـ <code>/ai</code>\n• <code>/setkey مفتاحك</code> لربط مفتاح Gemini المجاني\n\nالأوامر: /help · <code>/mp3 رابط</code> · <code>/mp4 رابط</code>',
    en: '👋 <b>Welcome to SaveLink</b>\n\nSend a link from TikTok, Instagram, Facebook or Pinterest and pick a format!\n\n🎬 <b>Movies & Series:</b>\n• <code>/movie Title</code>\n• <code>/series Title</code>\n\n🔓 <b>Ad-Link & Shortener Bypass:</b>\n• <code>/bypass link</code> (or paste short link directly)\n\n🤖 <b>AI Audio Transcribe & Summary:</b>\n• Send any voice note or audio file to transcribe & summarize\n• <code>/setkey your_key</code> to configure your free Gemini key\n\nCommands: /help · <code>/mp3 link</code> · <code>/mp4 link</code>',
  },
  help: {
    ar: '<b>كيف تستخدم البوت؟</b>\n1. انسخ رابط المنشور من التطبيق والصقه هنا.\n2. اختر الصيغة والجودة من الأزرار.\n\n🎬 <b>الأفلام والمسلسلات:</b>\n• <code>/movie اسم الفيلم</code> ← بحث وتحميل بجودات متعددة ومشاهدة مباشرة\n• <code>/series اسم المسلسل</code> ← تصفح المواسم والحلقات والجودات\n\n🔓 <b>تخطي الإعلانات وروابط الاختصار:</b>\n• <code>/bypass رابط</code> ← فك روابط bit.ly, adfly, linkvertise والوصول المباشر فوراً\n• فك تلقائي لأي رابط مختصر يتم إرساله للشات\n\n🤖 <b>الذكاء الاصطناعي والتفريغ الصوتي:</b>\n• أرسل أي تسجيل صوتي أو فويس نوت وسيقوم البوت بتفريغه وتلخيصه في 3 نقاط\n• زر [ 📝 تفريغ وتلخيص AI ] لتفريغ أي فيديو تم تنزيله\n• <code>/setkey مفتاحك</code> لربط مفتاح Google Gemini المجاني\n\n<b>إنستغرام وفيسبوك:</b>\n• <code>/dp @username</code> ← صورة الحساب HD\n• <code>/photos @username</code> ← صور وألبوم الحساب\n• <code>/story @username</code> ← الستوري النشط\n• <code>/highlights @username</code> ← الهايلايتس\n\n<b>ملاحظات:</b>\n• الحد الأقصى للإرسال: {maxMb} ميجابايت.\n• نزّل فقط ما تملك حق استخدامه.',
    en: '<b>How to use it</b>\n1. Copy the post link from the app and paste it here.\n2. Pick a format and quality from the buttons.\n\n🎬 <b>Movies & Series:</b>\n• <code>/movie Title</code> ← Search, multi-quality download & direct stream\n• <code>/series Title</code> ← Browse seasons, episodes & qualities\n\n🔓 <b>Ad-Link & Shortener Bypass:</b>\n• <code>/bypass link</code> ← Bypass bit.ly, adfly, linkvertise directly\n• Automatic unshortening for links sent in chat\n\n🤖 <b>AI Audio Transcribe & Summary:</b>\n• Send any voice note or audio file to transcribe and summarize into 3 key points\n• [ 📝 AI Transcribe ] button to transcribe downloaded videos\n• <code>/setkey your_key</code> to link free Google Gemini API key\n\n<b>Instagram & Facebook:</b>\n• <code>/dp @username</code> → profile picture HD\n• <code>/photos @username</code> → photos album\n• <code>/story @username</code> → active stories\n• <code>/highlights @username</code> → highlights\n\n<b>Notes:</b>\n• Upload limit: {maxMb} MB.\n• Only download content you have the rights to use.',
  },
  needLink: {
    ar: '🔗 أرسل رابط فيديو أو منشور من TikTok أو Instagram أو Facebook أو Pinterest.\nمثال: <code>https://www.instagram.com/reel/xxxx</code>',
    en: '🔗 Send a video or post link from TikTok, Instagram, Facebook or Pinterest.\nExample: <code>https://www.instagram.com/reel/xxxx</code>',
  },
  unsupported: {
    ar: '🚫 هذا الرابط غير مدعوم.\nالمدعوم: TikTok · Instagram · Facebook · Pinterest · YouTube',
    en: '🚫 That link is not supported.\nSupported: TikTok · Instagram · Facebook · Pinterest · YouTube',
  },
  resolving: {
    ar: '⏳ جاري فحص الرابط ({platform})…',
    en: '⏳ Inspecting the link ({platform})…',
  },
  videoBtn: {
    ar: '📹 {quality}{size}',
    en: '📹 {quality}{size}',
  },
  audioBtn: {
    ar: '🎵 {label}{size}',
    en: '🎵 {label}{size}',
  },
  imagesBtn: {
    ar: '🖼 صور ({n})',
    en: '🖼 Photos ({n})',
  },
  directLink: {
    ar: '🔗 تنزيل مباشر',
    en: '🔗 Direct download',
  },
  mp3Hint: {
    ar: '🎵 MP3؟ (غير متاح هنا)',
    en: '🎵 MP3? (not available here)',
  },
  mp3Unavailable: {
    ar: '🎵 تحويل الصوت إلى MP3 يحتاج ffmpeg، وهو غير متاح داخل Cloudflare Workers.\nأضف محرك yt-dlp المجاني (sidecar) ليحوّل أي فيديو إلى MP3 تلقائياً.',
    en: '🎵 MP3 encoding needs ffmpeg, which Cloudflare Workers cannot run.\nAdd the free yt-dlp sidecar engine to transcode any video to MP3 automatically.',
  },
  sending: {
    ar: '⏳ جاري تنزيل {label} وإرساله…',
    en: '⏳ Downloading {label} and sending it…',
  },
  sent: {
    ar: '✅ تم إرسال {label}.\nيمكنك اختيار صيغة أخرى من الأزرار.',
    en: '✅ {label} sent.\nPick another format from the buttons.',
  },
  resolveFailed: {
    ar: '❌ تعذّر استخراج الرابط.\n<code>{reason}</code>',
    en: '❌ Could not extract this link.\n<code>{reason}</code>',
  },
  downloadFailed: {
    ar: '❌ تعذّر تنزيل الملف.\n<code>{reason}</code>',
    en: '❌ Could not download the file.\n<code>{reason}</code>',
  },
  tooLarge: {
    ar: '⚠️ حجم الملف {size} يتجاوز حد التيليجرام ({limit}).\nاستخدم زر التنزيل المباشر.',
    en: '⚠️ The file is {size}, above the Telegram limit ({limit}).\nUse the direct download button.',
  },
  rateLimited: {
    ar: '🚦 وصلت للحد ({limit} طلب في الدقيقة).\nانتظر قليلاً ثم أعد المحاولة.',
    en: '🚦 Rate limit reached ({limit} requests/minute).\nWait a moment and try again.',
  },
  expired: {
    ar: '⌛ انتهت صلاحية الأزرار. أعد إرسال الرابط.',
    en: '⌛ These buttons expired. Send the link again.',
  },
  quickFailed: {
    ar: '❌ لم أجد رابطاً صالحاً في الأمر.\nمثال: <code>/mp3 https://vm.tiktok.com/xxxx</code>',
    en: '❌ No valid link found in that command.\nExample: <code>/mp3 https://vm.tiktok.com/xxxx</code>',
  },
  audioMissing: {
    ar: '🎵 لم أجد مساراً صوتياً مستقلاً لهذا الرابط.\nالمنشورات مثل ريلز إنستغرام تحتاج محرك yt-dlp لاستخراج MP3.',
    en: '🎵 No standalone audio track was found for this link.\nReels like Instagram need the yt-dlp engine to produce an MP3.',
  },
  profileHeader: {
    ar: '👤 <b>{name}</b>\n👥 {followers} متابع · 📸 {posts} منشور\n\n🖼 صورة الحساب جاهزة{photosLine}',
    en: '👤 <b>{name}</b>\n👥 {followers} followers · 📸 {posts} posts\n\n🖼 Profile picture ready{photosLine}',
  },
  profilePhotosLine: {
    ar: '\n📥 صور حديثة متاحة: {n}',
    en: '\n📥 Recent photos available: {n}',
  },
  profileDpBtn: {
    ar: '🖼 صورة الحساب{size}',
    en: '🖼 Profile picture{size}',
  },
  profilePhotosBtn: {
    ar: '📥 منشورات الحساب ({n})',
    en: '📥 Profile posts ({n})',
  },
  profileNoPhotos: {
    ar: '📥 لا توجد منشورات ظاهرة لهذا الحساب.\nيمكنك تنزيل صورة الحساب من الزر أعلاه.',
    en: '📥 No posts are visible for this account.\nYou can still download the profile picture above.',
  },
  profileHdNote: {
    ar: 'ℹ️ بدون تسجيل دخول يقدّم إنستغرام الصورة بدقة 150×150 فقط. لدقة كاملة أضف <code>IG_COOKIE</code>.',
    en: 'ℹ️ Without a session, Instagram only serves a 150×150 avatar. Add <code>IG_COOKIE</code> for the full-resolution one.',
  },
  profileHdActive: {
    ar: '✅ تم جلب الصورة بالدقة الكاملة (HD) عبر جلسة إنستغرام.',
    en: '✅ Full-resolution (HD) avatar fetched with your Instagram session.',
  },
  profileNotFound: {
    ar: '❌ لم أجد هذا الحساب. تأكد أن الاسم صحيح وأن الحساب عام (غير خاص).',
    en: '❌ I could not find that profile. Check the username and make sure the account is public.',
  },
  profilePrompt: {
    ar: '🖼 أرسل رابط حساب إنستغرام أو اسم المستخدم.\nمثال: <code>https://instagram.com/natgeo</code> أو <code>@natgeo</code>\n\nالأوامر: /dp صورة الحساب · /photos منشورات الحساب',
    en: '🖼 Send an Instagram profile link or username.\nExample: <code>https://instagram.com/natgeo</code> or <code>@natgeo</code>\n\nCommands: /dp profile picture · /photos profile posts',
  },
  photosSending: {
    ar: '⏳ جاري تنزيل {n} ملف (صور وفيديوهات) وإرسالها…',
    en: '⏳ Downloading and sending {n} media items…',
  },
  photosSent: {
    ar: '✅ تم إرسال {n} ملف من المنشورات.',
    en: '✅ {n} media items sent.',
  },
  photosPartial: {
    ar: 'ℹ️ أرسلت {n} ملفاً. هذا كل ما يعرضه إنستغرام للزائر غير المسجّل من حساب فيه {posts} منشوراً؛ المنشورات الأقدم لا تظهر للعامة.',
    en: 'ℹ️ Sent {n} items. This is everything Instagram shows anonymous visitors for an account with {posts} posts; older posts are not public.',
  },
  profileArchiveBtn: {
    ar: '📚 كل المنشورات ({n})',
    en: '📚 All posts ({n})',
  },
  archiveSending: {
    ar: '⏳ جاري جلب المنشورات من الأرشيف…',
    en: '⏳ Fetching posts from the archive…',
  },
  archiveMoreBtn: {
    ar: '⬇️ المزيد من المنشورات',
    en: '⬇️ More posts',
  },
  archiveProgress: {
    ar: '📚 أُرسل {sent} ملف (صور وفيديوهات) حتى الآن من أصل {total} منشوراً.\nاضغط «المزيد» لمتابعة الأقدم.',
    en: '📚 {sent} items (photos & videos) sent so far out of {total} posts.\nTap More to continue with older posts.',
  },
  archiveDone: {
    ar: '✅ اكتمل الأرشيف: تم إرسال {sent} ملف بالكامل (جميع الصور والفيديوهات).',
    en: '✅ Archive complete: {sent} items sent (all photos & videos).',
  },
  archiveFailed: {
    ar: '❌ تعذّر جلب الأرشيف. قد تكون جلسة إنستغرام منتهية — حدّث <code>IG_COOKIE</code>.',
    en: '❌ Could not fetch the archive. The Instagram session may have expired — refresh <code>IG_COOKIE</code>.',
  },
  archiveNeedsCookie: {
    ar: '🔐 الأرشيف الكامل يحتاج جلسة إنستغرام (<code>IG_COOKIE</code>).',
    en: '🔐 The full archive needs an Instagram session (<code>IG_COOKIE</code>).',
  },
  profileStoryBtn: {
    ar: '🟣 الستوري',
    en: '🟣 Stories',
  },
  profileHighlightsBtn: {
    ar: '✨ الهايلايتس',
    en: '✨ Highlights',
  },
  storiesSending: {
    ar: '⏳ جاري جلب الستوري…',
    en: '⏳ Fetching stories…',
  },
  storiesEmpty: {
    ar: '🟣 لا توجد ستوري نشطة لهذا الحساب (الستوري ينتهي بعد 24 ساعة).\nإن كانت ستوريك: تأكد أن حساب الكوكي يتابع الحساب، وأن الستوري لم تنتهِ.',
    en: '🟣 No active stories for this account (stories expire after 24 hours).\nIf these are yours: make sure the cookie account follows this profile and the story has not expired.',
  },
  storiesSent: {
    ar: '✅ تم إرسال {n} عنصر من الستوري.',
    en: '✅ Sent {n} story items.',
  },
  storiesNeedCookie: {
    ar: '🔐 الستوري يحتاج جلسة إنستغرام (<code>IG_COOKIE</code>).',
    en: '🔐 Stories need an Instagram session (<code>IG_COOKIE</code>).',
  },
  storiesFailed: {
    ar: '❌ تعذّر جلب الستوري: <code>{reason}</code>',
    en: '❌ Could not fetch stories: <code>{reason}</code>',
  },
  storiesCaption: {
    ar: '🟣 ستوري @{user} · {sent} عنصر',
    en: '🟣 @{user} stories · {sent} items',
  },
  highlightsSending: {
    ar: '⏳ جاري جلب الهايلايتس…',
    en: '⏳ Fetching highlights…',
  },
  highlightsEmpty: {
    ar: '✨ لا توجد هايلايتس ظاهرة لهذا الحساب.',
    en: '✨ No highlights are visible for this account.',
  },
  highlightsHeader: {
    ar: '✨ هايلايتس @{user} ({n})\nاختر واحداً:',
    en: '✨ @{user} highlights ({n})\nPick one:',
  },
  highlightsSent: {
    ar: '✅ أُرسل {n} عنصر من «{title}».',
    en: '✅ Sent {n} items from “{title}”.',
  },
  highlightsTooMany: {
    ar: 'ℹ️ أرسلت أول {sent} من {total} عنصراً.',
    en: 'ℹ️ Sent the first {sent} of {total} items.',
  },
  highlightsFailed: {
    ar: '❌ تعذّر جلب الهايلايت: <code>{reason}</code>',
    en: '❌ Could not fetch that highlight: <code>{reason}</code>',
  },
  fbProfileHeader: {
    ar: '👤 <b>{name}</b>\n📘 فيسبوك\n\n🖼 صورة الحساب جاهزة{photosLine}',
    en: '👤 <b>{name}</b>\n📘 Facebook\n\n🖼 Profile picture ready{photosLine}',
  },
  fbPhotosLine: {
    ar: '\n📸 صور الحساب المتاحة: {n}',
    en: '\n📸 Photos available: {n}',
  },
  fbPhotosBtn: {
    ar: '📸 صور الحساب ({n})',
    en: '📸 Profile photos ({n})',
  },
  fbNoPhotos: {
    ar: '📸 لا توجد صور ظاهرة لهذا الحساب على فيسبوك.\nيمكنك تنزيل صورة الحساب من الزر أعلاه.',
    en: '📸 No public photos visible for this account.\nYou can still download the profile picture above.',
  },
  fbPhotosSent: {
    ar: '✅ تم إرسال {n} صورة من صور الحساب على فيسبوك.',
    en: '✅ {n} Facebook profile photos sent.',
  },
  fbStoriesNeedCookie: {
    ar: '🔐 ستوري وهايلايتس الفيسبوك تحتاج جلسة فيسبوك (<code>FB_COOKIE</code>).',
    en: '🔐 Facebook stories and highlights require a Facebook session (<code>FB_COOKIE</code>).',
  },
  fbStoriesEmpty: {
    ar: '🟣 لا توجد ستوري نشطة لهذا الحساب على فيسبوك (الستوري ينتهي بعد 24 ساعة).',
    en: '🟣 No active Facebook stories for this account (stories expire after 24 hours).',
  },
  fbHighlightsEmpty: {
    ar: '✨ لا توجد هايلايتس (قصص مميزة) ظاهرة لهذا الحساب على فيسبوك.',
    en: '✨ No visible Facebook highlights found for this account.',
  },
  fbStoriesCaption: {
    ar: '🟣 ستوري فيسبوك: {name} · {sent} عنصر',
    en: '🟣 Facebook stories: {name} · {sent} items',
  },
  fbHighlightsCaption: {
    ar: '✨ هايلايتس فيسبوك: {title} · {sent} عنصر',
    en: '✨ Facebook highlights: {title} · {sent} items',
  },
  fbStoriesFailed: {
    ar: '❌ تعذّر جلب ستوري الفيسبوك: <code>{reason}</code>',
    en: '❌ Could not fetch Facebook stories: <code>{reason}</code>',
  },
  fbHighlightsFailed: {
    ar: '❌ تعذّر جلب هايلايتس الفيسبوك: <code>{reason}</code>',
    en: '❌ Could not fetch Facebook highlights: <code>{reason}</code>',
  },
  platform_tiktok: { ar: 'تيك توك', en: 'TikTok' },
  platform_instagram: { ar: 'إنستغرام', en: 'Instagram' },
  platform_facebook: { ar: 'فيسبوك', en: 'Facebook' },
  platform_pinterest: { ar: 'بينترست', en: 'Pinterest' },
  platform_youtube: { ar: 'يوتيوب', en: 'YouTube' },
  platform_coomer: { ar: 'Coomer', en: 'Coomer' },
  platform_erome: { ar: 'Erome', en: 'Erome' },
  platform_bunkr: { ar: 'Bunkr', en: 'Bunkr' },
  platform_unknown: { ar: 'غير معروف', en: 'Unknown' },
  ytChooseFormat: {
    ar: '🎬 <b>{title}</b>\n👤 {author} · ⏱ {duration}\n\nاختر الصيغة المطلوبة:',
    en: '🎬 <b>{title}</b>\n👤 {author} · ⏱ {duration}\n\nChoose the desired format:',
  },
  ytVideoFormatBtn: {
    ar: '📹 فيديو MP4',
    en: '📹 MP4 Video',
  },
  ytAudioFormatBtn: {
    ar: '🎵 صوت MP3',
    en: '🎵 MP3 Audio',
  },
  ytChooseVideoQuality: {
    ar: '📹 <b>اختر جودة الفيديو:</b>\n{title}',
    en: '📹 <b>Choose video quality:</b>\n{title}',
  },
  ytChooseAudioQuality: {
    ar: '🎵 <b>اختر جودة الصوت:</b>\n{title}',
    en: '🎵 <b>Choose audio quality:</b>\n{title}',
  },
  ytBackBtn: {
    ar: '⬅️ رجوع للصيغ',
    en: '⬅️ Back to formats',
  },
  ytPlaylistTitle: {
    ar: '📑 <b>قائمة تشغيل: {title}</b>\n👤 {author} · 🎬 {count} فيديو\n\nاختر طريقة التحميل:',
    en: '📑 <b>Playlist: {title}</b>\n👤 {author} · 🎬 {count} videos\n\nChoose download mode:',
  },
  ytPlaylistVideoBtn: {
    ar: '📹 تحميل القائمة فيديو MP4',
    en: '📹 Download playlist (MP4)',
  },
  ytPlaylistAudioBtn: {
    ar: '🎵 تحميل القائمة صوت MP3',
    en: '🎵 Download playlist (MP3)',
  },
  ytPlaylistBrowseBtn: {
    ar: '📋 استعراض الفيديوهات',
    en: '📋 Browse videos',
  },
  ytPlaylistQualityPrompt: {
    ar: '📑 <b>{title}</b>\nاختر جودة تحميل القائمة ({mode}):',
    en: '📑 <b>{title}</b>\nChoose playlist download quality ({mode}):',
  },
  ytPlaylistDownloading: {
    ar: '⏳ جاري تحميل القائمة ({done}/{total})…',
    en: '⏳ Downloading playlist ({done}/{total})…',
  },
  ytPlaylistNextBatch: {
    ar: '⬇️ تحميل الدفعة التالية ({next}/{total})',
    en: '⬇️ Download next batch ({next}/{total})',
  },
  ytPlaylistBrowseTitle: {
    ar: '📋 <b>فيديوهات القائمة ({page}/{totalPages}):</b>\n{title}\n\nاختر فيديو للتنزيل:',
    en: '📋 <b>Playlist videos ({page}/{totalPages}):</b>\n{title}\n\nPick a video to download:',
  },
  ytPlaylistDone: {
    ar: '✅ تم تحميل عناصر القائمة بنجاح!',
    en: '✅ Playlist items downloaded successfully!',
  },
  cmrProfileTitle: {
    ar: '✨ <b>{creator} ({service})</b>\n📑 الصفحة: {page} · 🎬 {count} فيديو متاح\nاختر فيديو للتنزيل:',
    en: '✨ <b>{creator} ({service})</b>\n📑 Page: {page} · 🎬 {count} videos available\nPick a video to download:',
  },
  cmrPrevPage: {
    ar: '⬅️ السابق ({offset})',
    en: '⬅️ Prev ({offset})',
  },
  cmrNextPage: {
    ar: '➡️ التالي ({offset})',
    en: '➡️ Next ({offset})',
  },
  cmrDownloading: {
    ar: '⏳ جاري تنزيل فيديو Coomer وإرساله…',
    en: '⏳ Downloading Coomer video…',
  },
  cmrNoVideos: {
    ar: '⚠️ لم يتم العثور على فيديوهات في هذه الصفحة من Coomer.',
    en: '⚠️ No videos found on this Coomer page.',
  },
  inlineSearchPrompt: {
    ar: '🎵 اكتب اسم الأغنية أو الفيديو للبحث السريع…',
    en: '🎵 Type a song or video name to search…',
  },
  directDownloadBtn: {
    ar: '⚡ تحميل مباشر عالي السرعة ({size})',
    en: '⚡ High-Speed Direct Download ({size})',
  },
  eromeSearchPrompt: {
    ar: '🔍 اكتب /erome متبوعاً بالاسم للبحث في Erome (مثال: /erome sexycreolyta4u)',
    en: '🔍 Type /erome <query> to search Erome (e.g. /erome sexycreolyta4u)',
  },
  bunkrSearchPrompt: {
    ar: '🔍 اكتب /bunkr متبوعاً بالاسم للبحث في Bunkr (مثال: /bunkr sexycreolyta4u)',
    en: '🔍 Type /bunkr <query> to search Bunkr (e.g. /bunkr sexycreolyta4u)',
  },
  eromeSearching: {
    ar: '🔍 جاري البحث في Erome عن: <b>{query}</b>…',
    en: '🔍 Searching Erome for: <b>{query}</b>…',
  },
  bunkrSearching: {
    ar: '🔍 جاري البحث في Bunkr عن: <b>{query}</b>…',
    en: '🔍 Searching Bunkr for: <b>{query}</b>…',
  },
  eromeNoResults: {
    ar: '⚠️ لم يتم العثور على ألبومات في Erome لـ: <b>{query}</b>',
    en: '⚠️ No albums found on Erome for: <b>{query}</b>',
  },
  bunkrNoResults: {
    ar: '⚠️ لم يتم العثور على نتائج في Bunkr لـ: <b>{query}</b>',
    en: '⚠️ No results found on Bunkr for: <b>{query}</b>',
  },
  eromeDownloading: {
    ar: '⏳ جاري تنزيل فيديو Erome وإرساله…',
    en: '⏳ Downloading Erome video…',
  },
  bunkrDownloading: {
    ar: '⏳ جاري تنزيل ملف Bunkr وإرساله…',
    en: '⏳ Downloading Bunkr file…',
  },
  moviePrompt: {
    ar: '🎬 <b>البحث عن الأفلام والمسلسلات:</b>\nأرسل اسم الفيلم أو المسلسل بعد الأمر.\nمثال: <code>/movie ولاد رزق 3</code> أو <code>/series الحشاشين</code>',
    en: '🎬 <b>Movie & Series Search:</b>\nSend the title after the command.\nExample: <code>/movie Welad Rezk 3</code> or <code>/series Al Hashasheen</code>',
  },
  movieSearching: {
    ar: '🔎 جاري البحث عن: <b>{query}</b>…',
    en: '🔎 Searching for: <b>{query}</b>…',
  },
  movieNotFound: {
    ar: '❌ لم يتم العثور على نتائج لـ <b>{query}</b>.\nتأكد من كتابة الاسم بصورة صحيحة.',
    en: '❌ No results found for <b>{query}</b>.\nPlease check the spelling.',
  },
  movieResultsHeader: {
    ar: '🎬 <b>نتائج البحث عن:</b> <code>{query}</code>\nاختر الفيلم أو المسلسل لعرض تفاصيله:',
    en: '🎬 <b>Search results for:</b> <code>{query}</code>\nSelect a movie or series for details:',
  },
  movieCard: {
    ar: '🎬 <b>{title}</b>\n{badge}\n{rating}\n\n📖 <b>القصة:</b>\n{story}\n\n👇 <b>اختر الجودة للتحميل أو المشاهدة:</b>',
    en: '🎬 <b>{title}</b>\n{badge}\n{rating}\n\n📖 <b>Story:</b>\n{story}\n\n👇 <b>Select a quality to download or stream:</b>',
  },
  seriesCard: {
    ar: '📺 <b>{title}</b>\n{badge}\n{rating}\n\n📖 <b>القصة:</b>\n{story}\n\n👇 <b>اختر الحلقة:</b>',
    en: '📺 <b>{title}</b>\n{badge}\n{rating}\n\n📖 <b>Story:</b>\n{story}\n\n👇 <b>Select an episode:</b>',
  },
  movieStreamReady: {
    ar: '✅ <b>جاهز للمشاهدة والتحميل!</b>\n🎬 <b>{title}</b>\n🎯 <b>الجودة:</b> {quality}\n📦 <b>الحجم:</b> {size}\n\n👇 <b>استخدم الروابط المباشرة أدناه:</b>',
    en: '✅ <b>Ready to stream and download!</b>\n🎬 <b>{title}</b>\n🎯 <b>Quality:</b> {quality}\n📦 <b>Size:</b> {size}\n\n👇 <b>Use the direct links below:</b>',
  },
  movieWatchBtn: {
    ar: '▶️ مشاهدة مباشرة (Stream)',
    en: '▶️ Direct Stream',
  },
  movieDownloadBtn: {
    ar: '⬇️ تحميل مباشر سريع',
    en: '⬇️ Fast Direct Download',
  },
  movieBackBtn: {
    ar: '🔙 رجوع',
    en: '🔙 Back',
  },
  bypassPrompt: {
    ar: '🔗 <b>فك وتخطي روابط الاختصار:</b>\nأرسل رابط الاختصار بعد الأمر.\nمثال: <code>/bypass https://tinyurl.com/xxxx</code>',
    en: '🔗 <b>Ad-Link & Shortener Bypass:</b>\nSend the link after the command.\nExample: <code>/bypass https://tinyurl.com/xxxx</code>',
  },
  bypassResolving: {
    ar: '⏳ جاري فك وتخطي رابط الاختصار…',
    en: '⏳ Unshortening and bypassing link…',
  },
  bypassSuccess: {
    ar: '🔓 <b>تم تخطي رابط الاختصار بنجاح!</b>\n\n🎯 <b>الرابط المباشر النهائي:</b>\n<code>{finalUrl}</code>\n\n🔄 عدد التحويلات: {hops}',
    en: '🔓 <b>Successfully bypassed!</b>\n\n🎯 <b>Direct Destination URL:</b>\n<code>{finalUrl}</code>\n\n🔄 Redirect hops: {hops}',
  },
  bypassFailed: {
    ar: '⚠️ لم يتغير الرابط أو تعذر فك التحويل:\n<code>{url}</code>',
    en: '⚠️ Link could not be bypassed or has no redirect:\n<code>{url}</code>',
  },
  bypassOpenBtn: {
    ar: '🌐 فتح الرابط المباشر',
    en: '🌐 Open Direct Link',
  },
  aiTranscribing: {
    ar: '🤖 ⏳ جاري الاستماع للمقطع الصوتي وتفريغه وتلخيصه بالذكاء الاصطناعي…',
    en: '🤖 ⏳ Processing audio with AI for transcription and summary…',
  },
  aiKeyNeeded: {
    ar: '🔐 <b>تفريغ الصوت والتلخيص بالذكاء الاصطناعي:</b>\nيتطلب هذا الأمر إضافة مفتاح Gemini API المجاني.\nاحصل على مفتاحك مجاناً بثوانٍ من:\n👉 <a href="https://aistudio.google.com/app/apikey">Google AI Studio</a>\nثم أضفه إلى متغيرات البيئة <code>GEMINI_API_KEY</code>.',
    en: '🔐 <b>AI Audio Transcribe & Summary:</b>\nThis feature requires a free Gemini API key.\nGet yours at:\n👉 <a href="https://aistudio.google.com/app/apikey">Google AI Studio</a>\nThen configure <code>GEMINI_API_KEY</code>.',
  },
  aiResult: {
    ar: '✨ <b>نتائج المعالجة بالذكاء الاصطناعي:</b>\n\n📝 <b>التفريغ الصوتي:</b>\n{transcript}\n\n💡 <b>أهم النقاط:</b>\n{summary}',
    en: '✨ <b>AI Audio Processing:</b>\n\n📝 <b>Transcript:</b>\n{transcript}\n\n💡 <b>Key Points:</b>\n{summary}',
  },
  aiBtn: {
    ar: '📝 تفريغ وتلخيص AI',
    en: '📝 AI Transcribe',
  },
  setKeyPrompt: {
    ar: '🔑 <b>تعيين مفتاح Google Gemini API:</b>\nأرسل المفتاح بعد الأمر.\nمثال: <code>/setkey AIzaSy...</code>\n\n💡 المفتاح مجاني 100% من Google AI Studio:\n👉 <a href="https://aistudio.google.com/app/apikey">aistudio.google.com/app/apikey</a>',
    en: '🔑 <b>Set Google Gemini API Key:</b>\nSend your key after the command.\nExample: <code>/setkey AIzaSy...</code>\n\n💡 Free 100% from Google AI Studio:\n👉 <a href="https://aistudio.google.com/app/apikey">aistudio.google.com/app/apikey</a>',
  },
  setKeySuccess: {
    ar: '✅ <b>تم حفظ مفتاح Gemini بنجاح!</b>\nأصبح بإمكانك الآن إرسال أي رسالة صوتية أو استخدام <code>/ai</code> لتفريغ الصوت وتلخيصه فوراً.',
    en: '✅ <b>Gemini API key saved successfully!</b>\nYou can now send voice notes or use <code>/ai</code> to transcribe and summarize instantly.',
  },
  setKeyInvalid: {
    ar: '⚠️ المفتاح يبدو غير صالح. يرجى التأكد من نسخه بدقة من Google AI Studio.',
    en: '⚠️ The API key appears invalid. Please make sure to copy it correctly from Google AI Studio.',
  },
  aiAudioTooLarge: {
    ar: '⚠️ حجم الملف الصوتي كبير جداً (الحد الأقصى للتفريغ الذكي هو 20 ميجابايت).',
    en: '⚠️ Audio file is too large (maximum size for AI processing is 20 MB).',
  },
  aiNoMediaFound: {
    ar: '⚠️ لم يتم العثور على تسجيل صوتي لتفريغه. قم بالرد على رسالة صوتية بالأمر <code>/ai</code> أو أرسل التسجيل الصوتي مباشرة للبوت.',
    en: '⚠️ No audio found. Reply to a voice note with <code>/ai</code> or send the voice note directly.',
  },
  bypassAutoResolved: {
    ar: '🔓 <b>تم تخطي رابط الاختصار تلقائياً:</b>\n🎯 <code>{finalUrl}</code>\n\n⏳ جاري استخراج الوسائط وتحميلها…',
    en: '🔓 <b>Automatically bypassed short link:</b>\n🎯 <code>{finalUrl}</code>\n\n⏳ Extracting and downloading media…',
  },
} satisfies Record<string, Entry>

export type StringKey = keyof typeof strings

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char)
}

export function pickLang(languageCode: string | undefined, env?: { BOT_LOCALE?: string }): Lang {
  const forced = env?.BOT_LOCALE?.toLowerCase()
  if (forced === 'ar' || forced === 'en') return forced
  return languageCode?.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const template = strings[key][lang]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

export function platformName(platform: string, lang: Lang): string {
  const key = `platform_${platform}` as StringKey
  return key in strings ? t(lang, key) : t(lang, 'platform_unknown')
}
