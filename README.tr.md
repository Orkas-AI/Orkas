# Orkas

**Masaüstünüzde açık kaynaklı bir yapay zekâ ajan ekibi: hedeflerinizi tamamlanmış işe dönüştürür ve işin durmadan ilerlemesini sağlar.**

Orkas, açık kaynaklı (MIT), yerel öncelikli, çok ajanlı bir masaüstü uygulamasıdır; ekip olarak çalışan bir yapay zekâ asistanıdır. **Commander**'a ne istediğinizi söyleyin: pek çok görevi kendi başına tamamlar; daha büyük işlerde ise adımları planlar ve uzman ajanları, zaten kullandığınız kodlama ve kişisel ajanlarla — **Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent** — birlikte bu iş üzerinde çalışmak üzere devreye sokar.

Orkas, yalnızca tek bir isteme yanıt vermek için değil, bir projeyi ilerletmek için tasarlandı. Bir **proje** hedefi, kuralları, belleği ve dosyaları barındırır; böylece her yeni sohbet, bir öncekinin kaldığı yerden devam eder. **Yapılacaklar** işi insanlar ve ajanlar arasında paylaştırır, **Otomatik ilerleme** ekibin sıradaki yapılacak işi kendiliğinden üstlenmesini sağlar, **zamanlanmış otomasyonlar** ise rutin işleri saatlik, günlük, haftalık veya aylık olarak tekrarlar. Tüm verileriniz bilgisayarınızda kalır ve tamamlanan işler incelemeniz için size geri gelir; böylece işletmenizin süregelen işlerini gönül rahatlığıyla Orkas'a emanet edebilirsiniz.

**[⬇ Orkas'ı macOS ve Windows için indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — ücretsizdir ve yerleşik Orkas modeli için 500 kredi içerir; yani başlamak için API anahtarına ihtiyacınız yok. Kendi anahtarlarınızı mı tercih edersiniz? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao veya yerel, OpenAI uyumlu bir uç nokta.

[![macOS ve Windows için indir](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![Lisans: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub yıldızları](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Sürüm](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Web sitesi: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas masaüstü uygulaması — görev sohbeti ve teslim edilen çıktılar](./resources/app-ui/task-en.png)

---

## Ekip neler teslim eder

- **Videolar, seslendirmeler ve görseller** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Araştırma raporları, SEO denetimleri ve pazar analizi** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Gönderiler, makaleler, bültenler ve sunumlar** — ContentWriter, PptMaker
- **Web siteleri, arayüzler ve kod** — UIDesigner, ProductDeveloper
- **Word, Excel, PowerPoint ve PDF dosyaları** — OfficeWorker
- **E-ticaret işleri** — ürün araştırması, ürün listelemeleri, yorum analizi, satış analizi ve katalog değişiklikleri; bunları beş e-ticaret ajanı üstlenir
- **Birkaç ajan gerektiren karmaşık işler** — Commander işi parçalara ayırır, her parçayı doğru ajana verir ve sonuçları birleştirir; örneğin bir rapora, bir sunuma ve bir lansman videosuna dönüşen bir pazar araştırması

Uygulamayla birlikte 16 uzman gelir; her birinin kendi becerileri, belleği ve araçları vardır. [Ajan mağazasında](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) 30+ ajana göz atın ya da ihtiyacınız olan rolü tarif edin; Commander sizin için özel bir ajan oluşturur.

<details>
<summary><b>16 yerleşik ajanın tamamı</b></summary>

| Alan | Ajan | Ne teslim eder |
| --- | --- | --- |
| Araştırma ve analiz | **DeepResearcher** | Doğrulanmış kaynaklar, işaretlenmiş çelişkiler ve denetlenebilir bir raporla kanıta dayalı araştırma |
| | **SeoGeoAgent** | Bir URL verin — teknik denetim, içerik kalitesi, Core Web Vitals, yapay zekâ yanıtlarında (GEO) alıntılanabilirlik, önceliğe göre sıralanmış düzeltme listesi |
| | **StockAnalyser** | Hisse senedi araştırması, faktör taramaları, geriye dönük testler ve portföy risk kontrolleri; izlenebilir panolarla |
| İçerik ve medya | **ContentWriter** | Bir hedeften, kaynaklardan veya kaba bir taslaktan yayına hazır gönderiler, makaleler, bültenler ve vaka çalışmaları |
| | **PptMaker** | Bir konu, ana hat veya belgeden düzenlenebilir, incelenebilir PPTX sunumlar |
| | **ImageStudio** | Afişler, kapaklar, sosyal medya görselleri ve infografikler |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Anlatım, yapay zekâ sunucuları (avatarlar), altyazılar ve dublaj, öne çıkan anlardan klipler, yerelleştirme ve kendi içeriğiniz ve görüntülerinizle referans videoyu yeniden oluşturma |
| | **VoiceStudio** | Anlatım, çok seslendiricili ses kayıtları, transkriptler ve altyazılar, ses düzenleme ve miksaj |
| | **UIDesigner** | Ürün hedeflerinden, PRD'lerden, ekran görüntülerinden veya Figma materyallerinden düzenlenebilir, HTML tabanlı arayüzler |
| Geliştirme ve ofis | **ProductDeveloper** | Deponuzu tanıyan mühendislik — PRD'yi hayata geçirme, hata düzeltme, yeniden düzenleme (refactoring), kod inceleme; doğrulanabilir sonuçlarla |
| | **OfficeWorker** | Word / Excel / PowerPoint / PDF dosyalarını tek tek veya toplu olarak oluşturma, düzenleme, kontrol etme ve teslim etme |
| E-ticaret | **ECommerceResearcher** | Bütçe, pazar ve tedarik kısıtlarına göre ürün seçimi — aday ürünler, eleme gerekçeleri, doğrulama planları |
| | **ECommerceWriter** | Marka dilinizle başlıklar, ürün detay sayfaları, SSS, görsel metinleri ve video senaryoları |
| | **ECommerceReviewer** | Yorum ve itibar analizi — müşterilerin öne çıkardığı konular, olumsuz yorumların kök nedenleri, öncelikler |
| | **ECommerceAnalyzer** | Dışa aktardığınız verilerle satış, kâr, reklam, iade ve stok analizi — mutabakatı yapılmış metrikler ve kararlar |
| | **ECommerceOperator** | Katalog, fiyat, promosyon ve stok değişikliklerini planlar; yalnızca bağladığınız araçlar üzerinden uygular |

Her ajan hakkında daha fazlası → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Referans bir videoyu kendi içeriğinizle yeniden oluşturun

**VideoStudio**, viral bir videonun anlatı yapısını, görsel stilini ve kurgu temposunu kendi ürününüz, senaryonuz ve görüntülerinizle yeniden oluşturabilir. Referans video dosyasını ve materyallerinizi verin: ajan, dikkat çeken açılışı, bilgi sırasını, görsel ritmi ve harekete geçirici mesajı analiz eder, ardından üretime geçmeden önce neyin korunacağını ve neyin değiştirileceğini önerir.

Bu yöntem en iyi sonucu hareketli grafikli açıklayıcı videolarda, SaaS veya uygulama demolarında ve mevcut görüntülerinizden hazırlanan ürün reklamlarında verir. Yerelde hazırlanan metinler, altyazılar, anlatım ve klipler ayrı ayrı düzenlenebilir; yapay zekâ ile üretilmiş görüntülere gömülü metni değiştirmek için o görüntünün kendisini değiştirmek gerekir.

> "reference.mp4 dosyasını referans alarak 30 saniyelik dikey bir tanıtım videosu hazırla. Dikkat çeken açılışını, yazı stilini ve temposunu koru; içeriği kendi ürünüm ve ekran kayıtlarımla değiştir ve önce bana videonun çözümlemesini ve planı göster."

Ajanın okuyabileceği bir video dosyasıyla başlayın; sosyal medya platformlarındaki paylaşım bağlantılarından video indirme özelliği yerleşik değildir. Kamera hareketlerinin birebir aynısı, oyuncuların performansı ve kare kare eşleşme garanti edilmez. [Referans videoyu yeniden oluşturma iş akışına](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md) bakın.

---

## İş durmadan ilerlesin

Tek bir görev iyi bir başlangıçtır. Orkas ise süregelen işler için tasarlandı.

- **Projeler** — hedefler ve kurallar, bellek ve dosyalar; projedeki her sohbet bunlarla başlar, böylece hiçbir zaman her şeyi sıfırdan anlatmanız gerekmez.
- **Yapılacaklar ve Otomatik ilerleme** — her projede insanlar ve ajanlar için bir yapılacaklar listesi vardır; Otomatik ilerleme açıkken ekip sıradaki maddeyi kendiliğinden alır ve tamamlanan işi incelemeniz için size geri getirir.
- **Zamanlanmış otomasyonlar** — herhangi bir görevi saatlik, günlük, haftalık veya aylık çalıştırın. Orkas bilgisayarınızda çalışır. v1.9'dan itibaren her otomasyon, bilgisayar uyandığında veya Orkas başladığında, son 12 saat içinde kaçırdığı en son çalıştırmayı telafi eder.
- **Bağlayıcılar** — Gmail, Google Calendar, Sheets ve Drive, Notion, Slack, Shopify, Stripe ve çok daha fazlası. Orkas varsayılan olarak herhangi bir şeyi göndermeden, yayınlamadan veya silmeden önce size sorar.
- **Uygulamalar** — bir araç tarif edin; Orkas onu masaüstü uygulamasının içinde yerel bir uygulama olarak oluşturur. Paketlenmiş uygulamada, ücretli planlarla bu uygulamayı herkese açık bağlantısı olan bir web uygulaması olarak da yayınlayabilirsiniz.
- **Paylaşılan projeler** *(paketlenmiş uygulama)* — bir ekip arkadaşınızı veya sanal asistanınızı davet edin ve her yapılacak işi bir kişiye ya da bir ajana atayın.

> [!NOTE]
> Paylaşılan projeler, bulut senkronizasyonu ve web uygulaması yayınlama yalnızca paketlenmiş uygulamada vardır; açık kaynaklı sürüm bunları henüz desteklemiyor. Bunları kullanmak için **[Orkas'ı macOS ve Windows için indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (ücretsiz, başlangıç için 500 kredi ile).

Sesle yazma, kaynak koddan derlenen sürümde de çalışır. **Ayarlar → Modeller** bölümünde bir **Orkas API anahtarı** yapılandırın, ardından mesaj kutusunun yanındaki mikrofona tıklayın. İstendiğinde mikrofon erişimine izin verin. Ses, tanınması için Orkas'a gönderilir ve anahtar sahibinin Orkas kredilerini kullanır. Durdurmak için yeniden tıklayın, metni gözden geçirin ve kendiniz gönderin. Erişimi reddettiyseniz mikrofonu sistem ayarlarınızdan etkinleştirin.

---

## Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent'ı birlikte çalıştırın

Orkas, bilgisayarınızda zaten kurulu olan CLI ajanlarını kendi uzmanlarının yanında yerel oturumlar olarak çalıştırır: kodlama ajanları **Claude Code, Codex ve OpenCode** ile kişisel ajanlar **OpenClaw ve Hermes-Agent**. Commander her birine en iyi yaptığı kısmı verir ve hepsi için tek bir plan yürütür; böylece tek bir sohbette hatayı düzeltebilir, değişikliği gözden geçirebilir ve sürüm notunun taslağını hazırlayabilirsiniz. HyperFrames gibi açık kaynaklı araçlar da aynı şekilde bağlanır.

[Claude Code ve Codex'i birlikte kullanmak →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Neden Orkas

- **Planlayan, görev dağıtan ve geri kalanını kendisi yapan bir Commander** — hedefleri parçalara ayırır; doğru ajanları, becerileri, bağlayıcıları ve araçları seçer; daha uygun bir uzman yoksa analiz, yazım, araştırma ve dosya işlerini kendisi üstlenir.
- **Tasarımı gereği yerel öncelikli** — sohbetler, dosyalar, bilgi tabanları ve özel ajanlar varsayılan olarak diskinizde kalır. Bulut senkronizasyonu paketlenmiş uygulamada isteğe bağlıdır. Kendi anahtarlarınızla model çağrıları doğrudan bilgisayarınızdan sağlayıcıya gider; yerleşik Orkas modeli ise Orkas'ın yönetilen model hizmeti üzerinden çalışır.
- **Modeli istediğiniz zaman değiştirebilirsiniz** — Commander ve yerleşik ajanlar tek bir model ayarını paylaşır: yerleşik Orkas modeli, kendi sağlayıcınız veya yerel bir uç nokta. Harici CLI ajanları kendi model ayarlarını korur.
- **Gelişen ajanlar** — her ajanın kendine özel becerileri ve belleği vardır. Arka planda çalışan değerlendirmeler, uygulama boştayken yeni etkinliği inceler ve öz değerlendirmeyi, yeniden kullanılabilir yöntemleri ve öğrenilmiş becerileri iyileştirebilir.
- **Açık kaynak, kara kutu yok** — MIT lisanslıdır. Orkas'ın ve her ajanla her becerinin tam olarak ne yaptığını okuyabilirsiniz.

> ⭐ Orkas işinize yarıyorsa, vereceğiniz bir yıldız projenin daha fazla kişi tarafından bulunmasına yardımcı olur.

---

## İndir

| | Paketlenmiş uygulama (önerilen) | Kaynak koddan çalıştırma |
| --- | --- | --- |
| Platformlar | macOS 12+ (Apple Silicon ve Intel), Windows 10+ | macOS, Windows, glibc 2.34+ Linux x64/arm64 |
| Hesap | Oturum açmak gerekir — 500 ücretsiz kredi | Gerekmez |
| Modeller | Yerleşik Orkas modeli veya kendi anahtarlarınız | Kendi anahtarlarınız veya yerel bir uç nokta |
| Ayrıca içerir | Proje iş birliği, uygulama yayınlama, bulut senkronizasyonu ve daha fazlası | — |
| Edinin | **[Orkas'ı indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Hızlı başlangıç](#hızlı-başlangıç) |

İndirme bağlantısı sisteminizi algılar ve doğru yükleyicinin indirilmesini başlatır.

---

## İnsanlar ne için kullanıyor

- **Pazarlama içeriği** — sizin üslubunuzla lansman videoları, ürün sayfaları, gönderiler ve bültenler. [İçerik yazımı](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Videolar](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Mağaza operasyonları** — haftalık satış özetleri, yorum yanıtları, ürün listelemeleri ve rakip kontrolleri. [E-ticaret](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Araştırma ve raporlar** — kaynak gösteren raporlar ve sunumlar, istendiğinde ya da her hafta. [Araştırma](https://orkas.ai/use/researchers/?source=gh-orkas) · [Veri analizi](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Belgelerinizle sohbet** — kendi dosyalarınıza dayanan ve kaynak pasajlara atıf yapan yanıtlar. [Belgelerle sohbet](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Müşteri işleri** — toplantı özetleri, aylık müşteri raporları ve kendi şablonunuzla hazırlanan durum güncelleme sunumları. [Aylık müşteri raporu şablonu](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Ürün lansmanı** — açılış sayfaları, testli hata düzeltmeleri, değişiklik günlükleri ve lansman gönderileri. [Geliştiriciler](https://orkas.ai/use/developers/?source=gh-orkas)
- **Uygulama oluşturun** — fiyat teklifi hesaplayıcıları, rezervasyon formları, şirket içi araçlar. [Uygulama oluşturma](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Küçük ekipler** — insanlar ve ajanlar için tek bir proje. [Küçük ekipler](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas'ın diğer araçlardan farkı

| Araç | Nedir | Orkas'ın farkı |
| --- | --- | --- |
| **Claude Code** | Anthropic'in ajan tabanlı kodlama aracı; terminalde, IDE'de, masaüstünde ve web'de çalışır, Claude modelleri üzerine kuruludur. | Birini seçmek zorunda değilsiniz: Orkas, Claude Code'u ajanlarından biri olarak çalıştırır. Orkas bunun etrafına, kodun ötesindeki işler (araştırma, içerik, video ve daha fazlası) için modelden bağımsız bir ekip ekler; işin ilerlemesini sağlayan projeler, yapılacaklar ve otomasyonlarla birlikte. [Orkas ile Claude Code karşılaştırması →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI'ın kodlama ajanı; terminalde, düzenleyicinizde ve bulutta çalışır. | Birini seçmek zorunda değilsiniz: Orkas, Codex'i Claude Code ve OpenCode'un yanında ajanlarından biri olarak çalıştırır. Commander kodlamayı Codex'e, incelemeyi başka bir ajana verebilir, ardından sürümün kod dışı yarısını (dokümantasyon, lansman gönderileri ve videolar) üstlenebilir. [Orkas ile Codex karşılaştırması →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | Anthropic'in günlük işler için geliştirdiği ajan, artık Claude'un bir parçası; ücretli bir Claude planıyla masaüstünde, web'de ve mobilde kullanılabilir. Varsayılan olarak Anthropic'in bulutunda çalışır ve Claude modellerini kullanır. | Claude Cowork için açık kaynaklı (MIT) bir alternatif; 500 krediyle ücretsiz başlayabilirsiniz. Orkas ajanlarını bilgisayarınızda çalıştırır ve verilerinizi varsayılan olarak yerelde tutar; yerleşik Orkas modeli, kendi sağlayıcı anahtarlarınız veya yerel bir uç nokta ile. Commander ayrıca Claude Code, Codex ve diğer CLI ajanlarını da devreye alabilir. Dezavantajı: Orkas için bilgisayarınızın uyanık olması gerekir; Cowork'ün bulut görevleri ise bilgisayar olmadan da çalışmaya devam edebilir. [Claude Cowork alternatifleri →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Görevleri varsayılan olarak Manus'un bulutunda planlayan ve yürüten bir yapay zekâ ajanı. Manus Studio masaüstü uygulaması (macOS ve Windows) seçtiğiniz bir klasörde de çalışabilir, ancak görevler yine bulutta planlanır. | Manus için açık kaynaklı (MIT) bir alternatif. Orkas ajanlarını bilgisayarınızda çalıştırır ve verilerinizi varsayılan olarak yerelde tutar; yerleşik Orkas modeli, kendi sağlayıcı anahtarlarınız veya yerel bir uç nokta ile. Projeler, yapılacaklar ve otomasyonlar işin ilerlemesini sağlar. Dezavantajı: Orkas için bilgisayarınızın uyanık olması gerekir; Manus'un bulut görevleri ise bilgisayar olmadan da çalışmaya devam edebilir. [Açık kaynaklı Manus alternatifi →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | LLM uygulamaları ve ajanlar oluşturmak için geliştiricilere yönelik bir framework/kütüphane; kod odaklıdır ve kendi Python/JS uygulamanıza gömülür. | Orkas, orkestrasyon kodu yazarak değil, sohbet yoluyla yönettiğiniz bir masaüstü uygulamasıdır. Veriler varsayılan olarak yerelde kalır. |
| **CrewAI** | Rol üstlenen otonom ajanları orkestre etmek için bir Python framework'ü; ekipleri ve ajanları kodda tanımlarsınız. | Orkas, çok ajanlı orkestrasyonu bir masaüstü uygulamasına taşır; projeler, yapılacaklar, otomasyonlar ve her ajanın kendini geliştirmesi yerleşik olarak gelir. |
| **OpenClaw** | Mesajlaşma entegrasyonları, çok ajanlı yönlendirme ve alt ajanlar sunan bir kişisel ajan platformu. | Orkas, tamamlanmış çıktılar için bir masaüstü çalışma alanı sunar; yerleşik uzmanlar içerir ve Claude Code, Codex, OpenCode ile diğer CLI ajanları arasında koordinasyon sağlar. OpenClaw bu iş akışına bir CLI ajanı olarak katılabilir. |
| **Hermes-Agent** | Nous Research'ün kendini geliştiren ajanı; bellek ve becerilere sahip tek bir ajandır ve CLI, mesajlaşma ağ geçidi ve masaüstü uygulaması olarak kullanılabilir. | Orkas bir ekibi koordine eder: Commander birçok uzmanı ve diğer CLI ajanlarını yönetir, Hermes-Agent de bunlardan biri olarak sisteme katılır. |

**Şunları istiyorsanız Orkas tam size göre:** tek bir asistan yerine bir ajan ekibi, günler boyunca ilerlemeye devam eden işler ve kendi diskinizde duran verileriniz, anahtarlarınız ve ajanlarınız.

**Tek istediğiniz şunlardan biriyse size göre değil:** çok amaçlı tek bir sohbet botu ya da kendi uygulamanıza gömeceğiniz saf bir kod kütüphanesi.

**Kodlama ajanları arasında seçim mi yapıyorsunuz?** [Codex mi, OpenCode mu?](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code mu, Codex mi, OpenCode mu?](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code alternatifleri](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Yan yana ayrıntılı karşılaştırmalar →** [Claude Code ile](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) · [Codex ile](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) · [Cline ile](https://orkas.ai/compare/orkas-vs-cline/?source=gh-orkas) · [LangChain ile](https://orkas.ai/compare/orkas-vs-langchain/?source=gh-orkas) · [ChatGPT ile](https://orkas.ai/compare/orkas-vs-chatgpt/?source=gh-orkas) · [OpenClaw ile](https://orkas.ai/compare/orkas-vs-openclaw/?source=gh-orkas) · [Hermes-Agent ile](https://orkas.ai/compare/orkas-vs-hermes-agent/?source=gh-orkas)

---

## Hızlı başlangıç

Bunun yerine paketlenmiş bir yükleyici mi istiyorsunuz? Yukarıdaki [İndir](#i̇ndir) bölümüne bakın. Kaynak koddan çalıştırmak için (Orkas'ı Linux'ta çalıştırmanın şu anki yolu budur):

**Gereksinimler**: Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 veya arm64. Platforma özgü bir modülün kaynaktan derlenmesi gereken nadir durumlar için Python 3 ve bir C/C++ derleme araç zincirini hazır bulundurun.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux'ta kaynaktan çalıştırmak için glibc 2.34+ gerekir. Alpine ve musl tabanlı diğer dağıtımlar desteklenmez. Yerel konuşma transkripsiyonu, kaynaktan ilk başlatma sırasında hedef platforma özgü whisper.cpp çalışma zamanını ve çok dilli modeli indirip doğrular.

`run.sh` / `run.cmd`, ilk başlatmada kilitli npm bağımlılık ağacını kurar; sabitlenmiş Python, uv, Node, embedding modeli (~95 MB), OfficeCLI, FFmpeg, whisper.cpp ve çok dilli konuşma modeli kaynaklarını hazırlar. Ardından Linux'ta başlangıçta, uygulama açılmadan önce platforma özgü modüller ve Whisper çalışma zamanı Electron'un ABI'si altında doğrulanır. OCR ve belirli becerilere özgü Python paketleri, bu özellikler ilk kez kullanıldığında yalıtılmış yerel ortamlara kurulur. İlk başlatma, `~/.orkas/` (macOS / Linux) veya `<smallest non-system drive>:\.orkas\` (Windows) altında bir çalışma alanı oluşturur. Ardından bir API anahtarı veya OAuth eklemek için **Ayarlar → Yapay zekâ sağlayıcıları** bölümünü açın.

Platforma özgü bağımlılık hatalarında: Node.js 24 LTS kullanın (en az 22.12.0), ardından
bu çalışma kopyasında `npm run native:repair` komutunu çalıştırın. Bu komut isteğe bağlı paketleri geri yükler,
SQLite'ı Electron için onarır, yalıtılmış görüntü işleme için uygulamayla gelen Node'u hazırlar
ve başarılı olduğunu bildirmeden önce SQL, sqlite-vec ve sharp'ı kontrol eder.
Kurulum yapmadan yalnızca kontrol için `npm run native:check` kullanın.
Yapılan kontroller için [platforma özgü bağımlılık doğrulama betiğine](./scripts/verify-native-dependencies.cjs) bakın.

---

## Nasıl çalışır

### Görev yönlendirme

Commander genel işleri kendisi yürütür, uzmanlık gerektiren işleri ise üç araçla devreder:

- **`dispatch_to`** adı belirtilen bir ajanı çalıştırır ve işe devam etmek için sonucunu döndürür. Sonucu bekleyebilir ya da eşzamansız çalışıp görev bittiğinde Commander'a bildirim gönderebilir.
- **`hand_off_to`** kalan işi adı belirtilen bir ajana devreder ve Commander'ın mevcut turunu sonlandırır. Yanıtı ajanın kendisi verir; isteğe bağlı bir devam adımı, Commander'ın daha sonra daha geniş bir göreve geri dönmesini sağlar.
- **`run_worker`** anonim, yalıtılmış bir alt görev çalıştırır ve yalnızca kendisine özel bir sonuç döndürür. Bu alt görev, sohbet geçmişini veya adı belirtilen bir ajanın becerilerini almaz.

Adı belirtilen ajan görevlerinin ve anonim çalışanların ayrı eşzamanlılık denetimleri vardır. [Görev dağıtımının koduna](./src/main/features/group_chat/bus.ts) ve [yürütme kilitlerine](./src/main/util/locks.ts) bakın.

### Bağlam yönetimi

Çalışma zamanı; istemleri, araçları ve kalıcı çalışma zamanı durumunu hesaba katarak bağlam bütçesini seçilen modelin kullanılabilir girdi kapasitesine göre belirler. Tamamlanmış diyaloglarda sınırlı bir yakın geçmiş penceresi kullanılır; uzun süren etkin görevlerde ise kontrol noktaları, son çalışmaları korurken önceki süreç mesajlarını özetler. Dosya okumaları, dosya değişiklikleri ve komut çalıştırmaları için ayrıca bağlam sıkıştırmasından sonra da korunabilen yapılandırılmış kayıtlar tutulur.

[Bağlam bütçelerine](./src/core-agent/src/agent/context-budget.ts), [oturum geçmişi ve kontrol noktalarına](./src/core-agent/src/agent/session.ts) ve [çalışma alanı kayıtlarına](./src/core-agent/src/agent/workspace-state.ts) bakın.

### Bellek ve Kütüphane

Kalıcı notlar; kullanıcı tercihlerini, proje bilgilerini ve her ajanın yeniden kullanılabilir bilgisini ayrı kapsamlarda tutar. Bu notlar, Kütüphane'nin belge dizininden ve saklanan sohbet geçmişinden ayrıdır.

Kütüphane, belgeleri pasajlara ayırır ve yerel bir SQLite vektör dizini saklar. Embedding modeli bilgisayarınızda çalışır; `library` aracı genel Kütüphane'de veya geçerli projeye ait Kütüphane'de dosyaları listeleyebilir, ilgili pasajları arayabilir ve kaynak içeriği okuyabilir. Önceki sohbetler ise ayrı olarak `chat_history` üzerinden getirilir.

[Kapsamlara ayrılmış belleğe](./src/main/features/memory.ts), [belge ayrıştırmaya](./src/main/util/file_to_chunks.ts), [Kütüphane araçlarına](./src/main/model/core-agent/kb-tools.ts) ve [sohbet geçmişinden getirmeye](./src/main/model/core-agent/chat-history-tools.ts) bakın.

### Yürütme sınırları ve kurtarma

Oturum kilitleri ve eşzamanlılık sınırları paralel işlere sınır koyar. Araç turu bütçeleri, ilerleme kontrol noktaları, tekrarlanan çağrı denetimleri ve aşamayı dikkate alan boşta kalma bekçileri, takılan veya işi tekrarlayan çalıştırmaları kontrol altında tutmaya yardımcı olur. Adı belirtilen ajan görevleri tek tek izlenebilir ve iptal edilebilir; kabul edilmiş veya kuyruğa alınmış bir görev, tamamlanmış bir sonuç olarak değerlendirilmez.

[Aktör bütçelerine](./src/main/features/group_chat/actor-budgets.ts), [ajan çalışma zamanına](./src/core-agent/src/agent/runner.ts) ve [masaüstü model bağdaştırıcısına](./src/main/model/core-agent/client.ts) bakın.

### Etkinlikten öğrenme

Arka plan değerlendirmeleri, bekleme süreleri ve yürütme sınırları çerçevesinde, uygulama boştayken yeni ajan etkinliğini inceler. Bir değerlendirme, ajanın öz değerlendirmesini (`COMPETENCE.md`), yeniden kullanılabilir yöntemlerini (`LEARNING_STRATEGIES.md`) veya öğrenilmiş becerilerini güncelleyebilir. Değerlendirmeler görev sayısına değil yeni etkinliğe bağlıdır ve kaydetmeye değer bir şey olmadığı sonucuna da varabilir.

[Yansıtma zamanlayıcısına](./src/main/features/reflection-orchestrator.ts) ve [değerlendirme istemine](./src/core-agent/src/evolution/metacognition.ts) bakın.

---

## SSS

**Orkas nedir?**
Orkas, açık kaynaklı (MIT), yerel öncelikli, çok ajanlı bir masaüstü uygulamasıdır. Commander, hedefinizi yapılacaklara dönüştürür ve tamamlanmış dosyalar teslim etmek için 16 yerleşik uzman ajanı ve bunlara ek olarak Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent'ı koordine eder. Tek bir sohbet botu, bir kod çerçevesi ya da barındırılan bir SaaS değildir.

**API anahtarına ihtiyacım var mı?**
Hayır. Paketlenmiş uygulama, yerleşik Orkas modeli için 500 krediyle gelir. Sonrasında kredi satın alabilir, ücretli bir plan seçebilir veya kendi sağlayıcı anahtarlarınızı ekleyebilirsiniz; sağlayıcı ücretleri ayrıca alınır.

**Orkas yerel bir LLM mi?**
Hayır. Orkas bilgisayarınızda çalışır ve seçtiğiniz modelleri çağırır: yerleşik Orkas modeli, kendi API anahtarlarınız veya yerel bir model uç noktası. Ajanları ve araçları yönetir; kendisi bir model değildir.

**Orkas belgelerimdeki bilgilere dayanarak, kaynak göstererek soruları yanıtlayabilir mi?**
Evet. PDF'leri ve belgeleri yerel Kütüphanenize ekleyin; Orkas bunlarda arama yapabilir ve kaynak pasajlara atıflarla yanıt verebilir, böylece orijinali açıp kontrol edebilirsiniz. Dizin bilgisayarınızda oluşturulur.

**Ollama veya LM Studio gibi yerel modelleri kullanabilir miyim?**
Evet. **Hesap ayarları → Modeller → Sohbet → Model ekle → Özel** yolunu açın, **OpenAI uyumlu** veya **Anthropic uyumlu** seçeneğini belirleyin ve temel URL'yi, tam model kimliğini ve API anahtarını girin. Kaydedilen modeli görevin model seçicisinden seçin.

**API anahtarlarım ve verilerim nerede saklanıyor?**
Varsayılan olarak diskinizde. Kendi sağlayıcı anahtarlarınız yerelde şifrelenir ve bulut senkronizasyonuna dahil edilmez. Kendi anahtarlarınızla model çağrıları doğrudan bilgisayarınızdan sağlayıcıya gider; yerleşik Orkas modeli Orkas'ın yönetilen hizmetini kullanır. Paketlenmiş uygulamadaki isteğe bağlı bulut senkronizasyonu ve paylaşılan projeler, seçilen verileri Orkas sunucularında saklar. [Güvenlik ve veri işleme →](https://orkas.ai/security/?source=gh-orkas)

**Orkas çevrimdışı çalışır mı?**
Kaynak koddan derlenen sürüm, yerel bir model uç noktasıyla tamamen çevrimdışı çalışabilir. Paketlenmiş uygulamada oturum açmak gerekir; bulut modelleri ise ağ bağlantısı gerektirir.

**Bilgisayarım kapalıyken de çalışmaya devam eder mi?**
Hayır. Orkas bilgisayarınızda çalışır; bu yüzden Otomatik ilerleme ve otomasyonlar için bilgisayarın uyanık ve Orkas'ın çalışıyor olması gerekir. v1.9'dan itibaren her otomasyon, bilgisayar uyandığında veya Orkas başladığında, son 12 saat içinde kaçırdığı en son çalıştırmayı telafi eder.

**Uygulama oluşturup yayınlayabilir miyim?**
Evet. Orkas içinde çalışan yerel uygulamalar ücretsizdir. Bir web uygulamasını herkese açık bir bağlantıda yayınlamak için ücretli plan gerekir (Lite 5, Pro 8, Max 15 uygulama) ve yayınlanan web uygulamaları Orkas içinde kullanılabilen tüm yetenekleri içermez.

**Orkas hesabına ihtiyacım var mı?**
Paketlenmiş masaüstü uygulaması, ilk kez başlattığınızda oturum açmanızı ister. Bu depodaki kaynak kod sürümünde hiçbir hesap katmanı yoktur; doğrudan uygulamayı açar.

**Orkas, Claude Code'u ve diğer CLI ajanlarını yönetebilir mi?**
Evet. Orkas beş harici CLI ajanını yerel alt süreçler olarak yönetebilir: kodlama ajanları Claude Code, Codex ve OpenCode ile kişisel ajanlar OpenClaw ve Hermes-Agent. Ayrıca HyperFrames gibi açık kaynaklı projeleri de sisteme dahil edebilir; hepsi aynı sohbetten yönetilir.

**Orkas'ın Claude Code / Codex / CrewAI / LangChain'den farkı nedir?**
Claude Code ve Codex kodlama ajanlarıdır; Orkas ikisini de ekibinin üyeleri olarak çalıştırır, böylece aralarında seçim yapmak zorunda kalmazsınız. CrewAI ve LangChain ise kod odaklı framework'lerdir. Orkas; bir Commander'ın uzman ajanlardan oluşan bir ekibi ve sizin CLI ajanlarınızı herhangi bir model sağlayıcısıyla koordine ettiği, verileri ve anahtarları yerelde tutan açık kaynaklı bir masaüstü uygulamasıdır. [Tüm karşılaştırmalara](https://orkas.ai/compare/?source=gh-orkas) bakın.

**Orkas hangi platformları destekler?**
macOS 12+ (Apple Silicon ve Intel) ve Windows 10+ için paketlenmiş yükleyiciler vardır. glibc 2.34+ Linux x64/arm64 bugün kaynak koddan çalışır; henüz yükleyicisi yoktur. Linux'ta yerel konuşma transkripsiyonu, ilk başlatmada hazırlanan sabitlenmiş whisper.cpp çalışma zamanıyla desteklenir. Alpine ve musl tabanlı diğer dağıtımlar desteklenmez. Kaynaktan başlatma için Node 22.12+ gerekir; Python 3 ve bir C/C++ derleme araç zinciri yalnızca platforma özgü bir npm paketinin uyumlu, önceden derlenmiş bir ikili dosyası olmadığında ve paketin yerelde yeniden derlenmesi gerektiğinde gerekir.

**Orkas ücretsiz ve açık kaynaklı mı?**
Evet. Uygulama MIT lisanslıdır ve ücretsiz kullanılabilir. Paketlenmiş uygulama, yerleşik Orkas modeli için 500 kredi içerir; aylık $11.99'dan başlayan ücretli planlar aylık kredi, bulut senkronizasyonu, daha fazla paylaşılan proje ve uygulama yayınlama ekler. Kendi anahtarlarınızı kullandığınızda model kullanımı sağlayıcınız tarafından faturalandırılır; Orkas üzerine ek ücret koymaz. [Fiyatlandırma →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Lisans

[MIT](./LICENSE)
