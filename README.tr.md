# Orkas

**Masaüstünüzde çalışan açık kaynaklı bir yapay zekâ ekibi. Hedeflerinizi tamamlanmış işlere dönüştürür ve projelerinizin ilerlemesini sağlar.**

Orkas, verileri öncelikle cihazınızda tutan, açık kaynaklı (MIT) ve çok ajanlı bir masaüstü uygulamasıdır. Ne istediğinizi **Commander**’a söyleyin: Birçok görevi kendisi tamamlar. Daha büyük işlerde adımları planlar; uzman ajanları ve hâlihazırda kullandığınız **Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent** gibi kodlama ve kişisel asistan ajanlarını birlikte çalıştırır.

Orkas, tek bir istemi yanıtlamanın ötesinde projenin ilerlemesini sağlar. Her **proje**, hedefi, kuralları, hafızayı ve dosyaları saklar; böylece yeni konuşmalar kaldığınız yerden devam eder. **Yapılacaklar listesi** işleri insanlar ve ajanlar arasında paylaştırır. **Otomatik ilerleme** ekibin sıradaki işi kendiliğinden üstlenmesini sağlar. **Zamanlanmış otomasyonlar** rutin işleri saatlik, günlük, haftalık veya aylık olarak tekrarlar. Verileriniz bilgisayarınızda kalır ve tamamlanan işler incelemenize sunulur.

**[⬇ macOS ve Windows için Orkas’ı indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — ücretsizdir. Yerleşik Orkas modeli için 500 krediyle gelir; başlamak için API anahtarı gerekmez. Kendi anahtarlarınızı kullanmak isterseniz Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Qwen, MiniMax, Doubao veya yerel bir OpenAI uyumlu uç nokta kullanabilirsiniz.

[![macOS ve Windows için indir](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![Lisans: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub yıldızları](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Sürüm](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Web sitesi: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas masaüstü: görev konuşması ve teslim edilen dosyalar](./resources/app-ui/task-en.png)

---

## Ekip neler yapar?

- **Video, seslendirme ve görsel** — VideoStudio, VoiceStudio, ImageStudio
- **Araştırma raporları, SEO denetimleri ve pazar analizi** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Gönderiler, makaleler, bültenler ve sunumlar** — ContentWriter, PptMaker
- **Web siteleri, arayüzler ve kod** — UIDesigner, ProductDeveloper
- **Word, Excel, PowerPoint ve PDF dosyaları** — OfficeWorker
- **E-ticaret işleri** — Beş uzman ajanla ürün araştırması, ürün ilanları, yorum ve satış analizi, katalog değişiklikleri.
- **Birden fazla ajan gerektiren işler** — Commander işi parçalara ayırır, her bölümü uygun ajana verir ve sonuçları birleştirir. Örneğin pazar araştırmasını rapora, sunuma ve lansman videosuna dönüştürür.

Uygulamada her biri kendi becerilerine, hafızasına ve araçlarına sahip 16 uzman ajan bulunur. [Ajan pazarında](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) 30’dan fazla ajanı inceleyin veya ihtiyacınız olan rolü tarif ederek Commander’ın size özel bir ajan oluşturmasını sağlayın.

<details>
<summary><b>Yerleşik 16 ajanın tamamı</b></summary>

| Alan | Ajan | Yaptığı işler |
| --- | --- | --- |
| Araştırma ve analiz | **DeepResearcher** | Doğrulanmış kaynaklar, işaretlenmiş çelişkiler ve denetlenebilir raporlarla kanıta dayalı araştırma |
| | **SeoGeoAgent** | Bir URL verin: teknik denetim, içerik kalitesi, Core Web Vitals, yapay zekâ yanıtlarında kaynak gösterilme olasılığı (GEO) ve öncelik sırasına göre düzeltmeler |
| | **StockAnalyser** | Hisse senedi araştırması, faktör bazlı tarama, geçmiş verilerle test ve portföy risk kontrolü; sonuçlar panolardan izlenebilir |
| İçerik ve medya | **ContentWriter** | Hedef, kaynak veya taslaktan yayıma hazır gönderiler, makaleler, bültenler ve vaka incelemeleri |
| | **PptMaker** | Konudan, taslaktan veya belgeden düzenlenebilir ve incelenebilir PPTX sunumları |
| | **ImageStudio** | Posterler, kapaklar, sosyal medya görselleri ve infografikler |
| | **VideoStudio** | Seslendirme, yapay zekâ sunucuları, altyazı, dublaj, öne çıkan kesitler, yerelleştirme ve kendi içeriklerinizle referans video uyarlama |
| | **VoiceStudio** | Seslendirme, çok sesli kayıt, konuşma dökümü, altyazı, ses düzenleme ve miksaj |
| | **UIDesigner** | Ürün hedeflerinden, gereksinim belgelerinden, ekran görüntülerinden veya Figma içeriklerinden düzenlenebilir, HTML tabanlı arayüzler |
| Yazılım ve ofis | **ProductDeveloper** | Depoyu dikkate alarak ürün gereksinimlerini uygular, hataları düzeltir, kodu yeniden düzenler ve inceler; sonuçlar doğrulanabilir |
| | **OfficeWorker** | Word, Excel, PowerPoint ve PDF dosyalarını tek tek veya toplu olarak oluşturur, düzenler, kontrol eder ve teslim eder |
| E-ticaret | **ECommerceResearcher** | Bütçe, pazar ve tedarik koşullarına göre ürün adayları, eleme gerekçeleri ve doğrulama planları |
| | **ECommerceWriter** | Marka üslubunuza uygun başlıklar, ürün sayfaları, SSS, görsel metinleri ve video senaryoları |
| | **ECommerceReviewer** | Müşteri yorumları ve itibar analizi; öne çıkan konular, olumsuz yorumların nedenleri ve öncelikler |
| | **ECommerceAnalyzer** | Dışa aktardığınız verilerden satış, kâr, reklam, iade ve stok analizi; tutarlılığı kontrol edilmiş ölçümler ve karar önerileri |
| | **ECommerceOperator** | Katalog, fiyat, kampanya ve stok değişikliklerini planlar; değişiklikleri yalnızca bağladığınız araçlarla uygular |

Ajanlar hakkında daha fazla bilgi → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Referans videoyu kendi içeriğinizle yeniden oluşturun

**VideoStudio**, popüler bir videonun anlatı yapısını, görsel tarzını ve kurgu temposunu sizin ürününüz, senaryonuz ve çekimlerinizle yeniden oluşturabilir. Referans videoyu ve kullanacağı malzemeleri verin. Ajan, dikkat çeken açılışı, bilgi sırasını, önemli görsel anları ve eylem çağrısını inceler; üretimden önce neleri koruyup neleri değiştireceğini önerir.

Bu yöntem mevcut çekimlerden hazırlanan hareketli grafik anlatımları, SaaS veya uygulama demoları ve ürün reklamları için daha uygundur. Ayrı oluşturulan metin, altyazı, seslendirme ve klipler sonradan düzenlenebilir. Yapay zekâyla üretilmiş görüntüye gömülü metni değiştirmek için görüntünün kendisini değiştirmek gerekir.

> “30 saniyelik dikey tanıtım videosu için reference.mp4 dosyasını örnek al. Dikkat çeken açılışı, yazı stilini ve tempoyu koru; içeriği ürünüm ve ekran kayıtlarımla değiştir. Önce analizini ve planını göster.”

Ajanın okuyabileceği bir video dosyasıyla başlayın. Sosyal medya paylaşım bağlantılarından indirme özelliği yoktur. Kamera hareketlerinin, insan performanslarının veya karelerin birebir eşleşmesi garanti edilmez. [Referans videoyu yeniden oluşturma iş akışına](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md) bakın.

---

## Projelerinizi ilerletin

Tek bir görev iyi bir başlangıçtır. Orkas, devam eden işler için tasarlandı.

- **Projeler** — Hedefler, kurallar, hafıza ve dosyalar projedeki her konuşmada kullanılabilir; her defasında işi yeniden anlatmanız gerekmez.
- **Yapılacaklar ve otomatik ilerleme** — Her projede insanlar ve ajanlar için bir yapılacaklar listesi vardır. Otomatik ilerleme açıkken ekip sıradaki işi kendiliğinden üstlenir ve tamamladığında incelemenize sunar.
- **Zamanlanmış otomasyonlar** — Herhangi bir görevi saatlik, günlük, haftalık veya aylık çalıştırın. Orkas bilgisayarınızda çalışır. 1.9 sürümünden itibaren bilgisayar uyandığında veya Orkas açıldığında, her otomasyon son 12 saat içinde kaçırdığı en son çalıştırmayı telafi eder.
- **Bağlayıcılar** — Gmail, Google Takvim, E-Tablolar ve Drive, Notion, Slack, Shopify, Stripe ve daha fazlası. Orkas varsayılan olarak bir şey göndermeden, yayımlamadan veya silmeden önce onay ister.
- **Uygulamalar** — İhtiyacınız olan aracı tarif edin; Orkas bunu masaüstü uygulamasının içinde çalışan yerel bir uygulama olarak oluşturur. Ücretli planlarda, hazır kurulumlu sürümden herkese açık bağlantısı olan bir web uygulaması olarak da yayımlayabilirsiniz.
- **Paylaşılan projeler** *(hazır kurulumlu sürüm)* — Bir ekip arkadaşınızı veya sanal asistanınızı davet edin; listedeki her işi bir kişiye ya da ajana atayın.

> [!NOTE]
> Paylaşılan projeler, bulut eşitleme ve web uygulaması yayımlama yalnızca hazır kurulumlu sürümde bulunur. Kaynak koddan derlenen sürüm henüz bunları desteklemiyor. Kullanmak için **[macOS ve Windows için Orkas’ı indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)**. Uygulama ücretsizdir ve başlangıçta 500 kredi verir.

Sesli giriş, kaynak koddan derlenen sürümde de çalışır. **Ayarlar → Modeller** bölümünde bir **Orkas API anahtarı** yapılandırın ve mesaj kutusunun yanındaki mikrofona tıklayın. İstendiğinde mikrofon izni verin. Ses, tanınması için Orkas’a gönderilir ve anahtar sahibinin Orkas kredilerinden düşülür. Kaydı durdurmak için yeniden tıklayın, metni inceleyin ve kendiniz gönderin. İzin vermediyseniz mikrofonu sistem ayarlarından etkinleştirin.

---

## Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent’ı birlikte çalıştırın

Orkas, kurulu komut satırı (CLI) ajanlarınızı kendi uzmanlarıyla birlikte yerel oturumlarda çalıştırır: kodlama için **Claude Code, Codex ve OpenCode**; kişisel asistan olarak **OpenClaw ve Hermes-Agent**. Commander, tek bir plan üzerinden her ajana en iyi yapabildiği işi verir. Böylece tek bir konuşmada hatayı düzeltebilir, değişikliği inceletebilir ve sürüm notunu hazırlatabilirsiniz. HyperFrames gibi açık kaynak araçları da aynı şekilde ekleyebilirsiniz.

[Claude Code ve Codex’i birlikte kullanma →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Neden Orkas?

- **Planlayan, görev dağıtan ve kalan işleri üstlenen Commander** — Hedefleri parçalara ayırır; uygun ajanları, becerileri, bağlayıcıları ve araçları seçer. Uzman gerekmiyorsa analiz, yazım, araştırma ve dosya işlerini kendisi yapar.
- **Veriler varsayılan olarak cihazda kalır** — Konuşmalar, dosyalar, bilgi tabanları ve özel ajanlar diskinizde saklanır. Hazır kurulumlu sürümde bulut eşitleme isteğe bağlıdır. Kendi anahtarlarınızı kullanırsanız model istekleri cihazınızdan doğrudan sağlayıcıya gider. Yerleşik model, Orkas’ın yönettiği model hizmetini kullanır.
- **Modeli istediğiniz zaman değiştirin** — Commander ve yerleşik ajanlar aynı model ayarını kullanır: yerleşik Orkas modeli, seçtiğiniz sağlayıcı veya yerel uç nokta. Harici CLI ajanları kendi model ayarlarını korur.
- **Zamanla gelişen ajanlar** — Her ajan kendine ait becerileri ve hafızayı saklar. Uygulama boştayken arka plan incelemeleri yeni etkinliği değerlendirir; öz değerlendirmeleri, tekrar kullanılabilecek yöntemleri ve öğrenilen becerileri iyileştirebilir.
- **Açık kaynak, nasıl çalıştığı şeffaf** — MIT lisanslıdır. Orkas’ın, ajanların ve becerilerin ne yaptığını kaynak koddan inceleyebilirsiniz.

> ⭐ Orkas işinize yarıyorsa GitHub’da yıldız vererek daha fazla kişinin projeyi bulmasına yardımcı olabilirsiniz.

---

## İndirme

| | Hazır kurulumlu sürüm (önerilen) | Kaynak koddan çalıştırma |
| --- | --- | --- |
| Platformlar | macOS 12+ (Apple Silicon ve Intel), Windows 10+ | macOS, Windows, glibc 2.34+ kullanan Linux x64/arm64 |
| Hesap | Oturum açın; 500 ücretsiz kredi | Hesap gerekmez |
| Modeller | Yerleşik Orkas modeli veya kendi anahtarlarınız | Kendi anahtarlarınız veya yerel bir uç nokta |
| Ek özellikler | Proje işbirliği, uygulama yayımlama, bulut eşitleme ve daha fazlası | — |
| Başlayın | **[Orkas’ı indirin](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Hızlı başlangıç](#hızlı-başlangıç) |

İndirme bağlantısı işletim sisteminizi algılar ve uygun kurulum programını başlatır.

---

## Kullanım örnekleri

- **Pazarlama içeriği** — Kendi üslubunuzda lansman videoları, ürün sayfaları, gönderiler ve bültenler. [İçerik yazımı](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Videolar](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Mağaza işleri** — Haftalık satış özetleri, yorumlara yanıtlar, ürün ilanları ve rakip incelemeleri. [E-ticaret](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Araştırma ve raporlar** — İsteğe bağlı veya haftalık, kaynaklara dayanan raporlar ve sunumlar. [Araştırma](https://orkas.ai/use/researchers/?source=gh-orkas) · [Veri analizi](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Belgelerinizle sohbet** — Kendi dosyalarınıza dayanan ve ilgili bölümlere atıf yapan yanıtlar. [Belgelerle sohbet](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Müşteri işleri** — Kendi şablonunuzla toplantı özetleri, aylık müşteri raporları ve durum sunumları. [Aylık müşteri raporu şablonu](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Ürün lansmanı** — Açılış sayfaları, testleriyle birlikte hata düzeltmeleri, değişiklik günlükleri ve lansman gönderileri. [Geliştiriciler](https://orkas.ai/use/developers/?source=gh-orkas)
- **Uygulama geliştirme** — Teklif hesaplayıcıları, rezervasyon formları ve şirket içi araçlar. [Uygulama oluşturma](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Küçük ekipler** — İnsan ve ajanların birlikte çalıştığı tek bir proje. [Küçük ekipler](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas ve benzer araçlar

| Araç | Ne yapar? | Orkas’ın farkı |
| --- | --- | --- |
| **Claude Code** | Anthropic’in Claude modellerine dayanan ajanlı kodlama aracı. Terminalde, IDE’de, masaüstünde ve web’de kullanılabilir. | Orkas, Claude Code’u ekipteki ajanlardan biri olarak çalıştırır. Araştırma, içerik ve video gibi kodlama dışı işler için de sağlayıcıdan bağımsız bir ekip, projeler, yapılacaklar ve otomasyonlar sunar. [Orkas ve Claude Code karşılaştırması →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI’ın terminalde, düzenleyicide ve bulutta çalışan kodlama ajanı. | Orkas; Codex’i Claude Code ve OpenCode’la birlikte çalıştırabilir. Commander kodlamayı Codex’e, incelemeyi başka bir ajana verebilir; sürümün belge, duyuru ve video kısmını da koordine eder. [Orkas ve Codex karşılaştırması →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | Anthropic’in günlük işler için geliştirdiği ajan. Ücretli Claude planıyla masaüstünde, web’de ve mobilde kullanılabilir. Varsayılan olarak Anthropic’in bulutunda çalışır ve Claude modellerini kullanır. | Orkas, 500 başlangıç kredisi sunan ücretsiz ve açık kaynaklı (MIT) bir alternatiftir. Ajanları bilgisayarınızda çalıştırır, verileri varsayılan olarak cihazda tutar ve yerleşik modeli, kendi sağlayıcı anahtarlarınızı veya yerel uç noktayı kullanabilir. Commander, Claude Code, Codex ve diğer CLI ajanlarını da ekleyebilir. Orkas için bilgisayar açık ve uyanık kalmalıdır; Cowork’un bulut görevleri bilgisayar kapalıyken de sürebilir. [Claude Cowork alternatifleri →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Görevleri varsayılan olarak Manus bulutunda planlayan ve yürüten bir yapay zekâ ajanı. Manus Studio (macOS ve Windows), seçtiğiniz klasörde çalışabilir; görev planlaması yine bulutta yapılır. | Orkas açık kaynaklı (MIT) bir alternatiftir. Yerleşik model, kendi sağlayıcı anahtarlarınız veya yerel uç noktayla çalışır; ajanları ve verileri varsayılan olarak cihazda tutar. Projeler, yapılacaklar ve otomasyonlar işlerin ilerlemesini sağlar. Orkas için bilgisayar açık ve uyanık kalmalıdır; Manus’un bulut görevleri bilgisayar kapalıyken de sürebilir. [Açık kaynaklı Manus alternatifi →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Python veya JavaScript uygulamalarınıza ekleyerek LLM uygulamaları ve ajanlar geliştirmenizi sağlayan kod tabanlı çerçeve ve kitaplık. | Orkas, sohbet üzerinden yönettiğiniz bir masaüstü uygulamasıdır. Ajanları koordine etmek için kod yazmanız gerekmez; veriler varsayılan olarak cihazda kalır. |
| **CrewAI** | Rollere göre çalışan otonom ajanları koordine etmek için Python çerçevesi. Ekipleri ve ajanları kodla tanımlarsınız. | Orkas, ajan koordinasyonunu hazır projeler, yapılacaklar, otomasyonlar ve her ajanın kendi deneyiminden öğrenmesiyle masaüstüne taşır. |
| **OpenClaw** | Mesajlaşma entegrasyonları, ajan yönlendirme ve alt ajan desteği olan kişisel asistan platformu. | Orkas, tamamlanmış çıktılar için masaüstünde bir çalışma alanı sunar; yerleşik uzmanları Claude Code, Codex, OpenCode ve başka CLI ajanlarıyla koordine eder. OpenClaw da bu akışa bir CLI ajanı olarak katılabilir. |
| **Hermes-Agent** | Nous Research’ün hafızası ve becerileriyle kendini geliştiren ajanı. CLI, mesajlaşma ağ geçidi ve masaüstü uygulaması olarak kullanılabilir. | Commander uzmanları ve CLI ajanlarını tek ekip olarak yönetir. Hermes-Agent da ekip üyelerinden biri olabilir. |

**Orkas size uygun olabilir:** Bir ajan ekibi istiyorsanız, işlerin günler boyunca ilerlemesi önemliyse ve verilerinizi, anahtarlarınızı ve ajanlarınızı kendi diskinizde tutmak istiyorsanız.

**Başka bir araç daha uygun olabilir:** Yalnızca genel amaçlı tek bir sohbet botu veya uygulamanıza gömebileceğiniz bir kod kitaplığı arıyorsanız.

**Kodlama ajanı mı seçiyorsunuz?** [Codex ve OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code, Codex ve OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code alternatifleri](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Ayrıntılı karşılaştırmalar →** [Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Hızlı başlangıç

Hazır kurulum programı için yukarıdaki [İndirme](#indirme) bölümüne bakın. Linux’ta Orkas şu anda kaynak koddan çalıştırılır.

**Gereksinimler:** Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ kullanan Linux x64 veya arm64. Yerel modüllerin nadiren kaynak koddan derlenmesi gerekebileceğinden Python 3 ve bir C/C++ derleme araç zinciri hazır bulundurun.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux’ta kaynak koddan çalıştırmak için glibc 2.34+ gerekir. Alpine ve musl tabanlı diğer dağıtımlar desteklenmez. Yerel konuşma tanıma için, kaynak koddan ilk başlatmada platforma uygun whisper.cpp çalışma zamanı ve çok dilli model indirilip doğrulanır.

`run.sh` ve `run.cmd`, npm bağımlılıklarını kilit dosyasındaki sürümlerle kurar. İlk açılışta sabitlenmiş Python, uv, Node, vektörleştirme modeli (~95 MB), OfficeCLI, FFmpeg, whisper.cpp ve çok dilli konuşma modeli kaynaklarını hazırlar. Linux’ta uygulama açılmadan önce yerel modüller ve Whisper çalışma zamanı Electron ABI’siyle doğrulanır. OCR ve becerilere özel Python paketleri, ilgili özellik ilk kullanıldığında yalıtılmış yerel ortamlara kurulur. İlk açılışta macOS ve Linux’ta `~/.orkas/`, Windows’ta `<smallest non-system drive>:\.orkas\` altında bir çalışma alanı oluşturulur. API anahtarı veya OAuth eklemek için **Ayarlar → Yapay Zekâ Sağlayıcıları**’nı açın.

Yerel bağımlılık hatalarında Node.js 24 LTS kullanın (en düşük sürüm 22.12.0). Ardından
depo dizininde `npm run native:repair` komutunu çalıştırın. Bu komut isteğe bağlı paketleri geri yükler,
SQLite’ı Electron için onarır, yalıtılmış görsel işleme için paketle gelen Node’u hazırlar
ve başarılı sayılmadan önce SQL, sqlite-vec ve sharp’ı kontrol eder.
Kurulum yapmadan kontrol etmek için `npm run native:check` komutunu kullanın.
Hangi kontrollerin yapıldığını görmek için [yerel bağımlılık doğrulama betiğine](./scripts/verify-native-dependencies.cjs) bakın.

---

## Nasıl çalışır?

### Görev yönlendirme

Commander genel işleri kendisi yürütür, uzmanlık gerektiren işleri üç araçla devreder:

- **`dispatch_to`** belirli bir ajanı çalıştırır ve sonucu, işin devamında kullanılmak üzere döndürür. Sonucu bekleyebilir veya eşzamansız çalışıp tamamlandığında Commander’a bildirebilir.
- **`hand_off_to`** kalan işi belirli bir ajana devreder ve Commander’ın o anki sırasını sonlandırır. Ajan kendi yanıtını verir; istenirse Commander daha sonra işin genelini sürdürür.
- **`run_worker`** adı olmayan bir işçiye yalıtılmış bir alt görev verir ve özel bir sonuç döndürür. İşçiye konuşma geçmişi veya belirli bir ajanın becerileri aktarılmaz.

Belirli ajanların görevleri ile adı olmayan işçiler için ayrı eşzamanlılık kontrolleri vardır. [Görev gönderme koduna](./src/main/features/group_chat/bus.ts) ve [yürütme kilitlerine](./src/main/util/locks.ts) bakın.

### Bağlam yönetimi

Çalışma zamanı; istemleri, araçları ve kalıcı çalışma durumunu hesaba katarak bağlamı modelin kullanabileceği girdi kapasitesine göre sınırlar. Tamamlanmış konuşmalarda yalnızca yakın geçmişin belirli bir bölümü tutulur. Uzun süren etkin görevlerde, yeni çalışmalar korunurken eski işlem mesajları kontrol noktalarıyla özetlenir. Dosya okuma, dosya değişikliği ve komut çalıştırma kayıtları da bağlam kısaltıldığında korunabilir.

[Bağlam bütçelerine](./src/core-agent/src/agent/context-budget.ts), [oturum geçmişi ve kontrol noktalarına](./src/core-agent/src/agent/session.ts) ve [çalışma alanı kayıtlarına](./src/core-agent/src/agent/workspace-state.ts) bakın.

### Hafıza ve Kitaplık

Kalıcı notlar; kullanıcı tercihlerini, projeye ilişkin bilgileri ve her ajanın yeniden kullanabileceği bilgileri ayrı kapsamlar altında tutar. Bu notlar, Kitaplığın belge dizininden ve saklanan konuşma geçmişinden ayrıdır.

Kitaplık, belgeleri bölümlere ayırır ve yerel bir SQLite vektör dizininde saklar. Vektörleştirme modeli bilgisayarınızda çalışır. `library` aracı genel Kitaplıktaki veya proje Kitaplığındaki dosyaları listeleyebilir, ilgili bölümleri arayabilir ve kaynak içeriğini okuyabilir. Önceki konuşmalar `chat_history` ile ayrıca getirilir.

[Kapsama göre hafıza](./src/main/features/memory.ts), [belge içeriğini çıkarma](./src/main/util/file_to_chunks.ts), [Kitaplık araçları](./src/main/model/core-agent/kb-tools.ts) ve [konuşma geçmişini getirme](./src/main/model/core-agent/chat-history-tools.ts) hakkında ayrıntılar.

### Yürütme sınırları ve kurtarma

Oturum kilitleri ve eşzamanlılık sınırları paralel çalışmayı denetler. Araç çağrısı turu sınırları, ilerleme kontrol noktaları, tekrarlanan çağrı kontrolleri ve işin aşamasına göre boşta kalma süresini izleyen mekanizmalar, takılan veya işi yineleyen çalıştırmaları sınırlar. Belirli ajanların görevleri tek tek izlenebilir ve iptal edilebilir. Kabul edilen veya kuyruğa alınan görev tamamlanmış sayılmaz.

[Yürütücü bütçelerine](./src/main/features/group_chat/actor-budgets.ts), [ajan çalışma zamanına](./src/core-agent/src/agent/runner.ts) ve [masaüstü model bağdaştırıcısına](./src/main/model/core-agent/client.ts) bakın.

### Etkinlikten öğrenme

Arka plan incelemeleri, uygulama boştayken yeni ajan etkinliklerini değerlendirir. İncelemeler arasında bekleme süresi ve yürütme sınırları vardır. İnceleme, ajanın öz değerlendirmesini (`COMPETENCE.md`), tekrar kullanılabilir yöntemlerini (`LEARNING_STRATEGIES.md`) veya öğrendiği becerileri güncelleyebilir. İncelemeyi görev sayısı yerine yeni etkinlik belirler; kaydetmeye değer bir şey bulunmayabilir.

[Öz değerlendirme zamanlayıcısına](./src/main/features/reflection-orchestrator.ts) ve [inceleme istemine](./src/core-agent/src/evolution/metacognition.ts) bakın.

---

## Sık sorulan sorular

**Orkas nedir?**
Orkas, verileri öncelikle cihazınızda tutan açık kaynaklı (MIT), çok ajanlı bir masaüstü uygulamasıdır. Commander hedefinizi yapılacak işlere dönüştürür. Teslim edilecek dosyaları hazırlamak için 16 yerleşik uzmanı ve Claude Code, Codex, OpenCode, OpenClaw ve Hermes-Agent’ı koordine eder. Kapsamı tek bir sohbet botundan, kod çerçevesinden veya barındırılan bir SaaS hizmetinden farklıdır.

**API anahtarına ihtiyacım var mı?**
Hayır. Hazır kurulumlu sürüm, yerleşik Orkas modeli için 500 krediyle gelir. Sonrasında kredi satın alabilir, ücretli plan seçebilir veya kendi sağlayıcı anahtarlarınızı ekleyebilirsiniz. Sağlayıcı ücretleri ayrıca hesaplanır.

**Orkas yerel bir dil modeli mi?**
Hayır. Orkas cihazınızda çalışır ve seçtiğiniz modelle bağlantı kurar. Yerleşik Orkas modelini, kendi API anahtarınızla eriştiğiniz modelleri veya yerel bir model uç noktasını kullanabilirsiniz. Orkas’ın görevi ajanları ve araçları koordine etmektir.

**Orkas belgelerime dayanarak kaynak gösteren yanıtlar verebilir mi?**
Evet. PDF ve diğer belgelerinizi yerel Kitaplığa ekleyin. Orkas belgelerde arama yapıp ilgili bölümlere atıfla yanıt verebilir; böylece kaynağı açıp kontrol edebilirsiniz. Belge dizini cihazınızda oluşturulur.

**Ollama veya LM Studio gibi yerel model hizmetlerini kullanabilir miyim?**
Evet. **Hesap ayarları → Modeller → Sohbet → Model ekle → Özel** yolunu izleyin. **OpenAI uyumlu** veya **Anthropic uyumlu** seçeneğini işaretleyip temel URL’yi, model kimliğini olduğu gibi ve API anahtarını girin. Kaydettiğiniz modeli görevdeki model seçicisinden seçin.

**API anahtarlarım ve verilerim nerede saklanıyor?**
Varsayılan olarak diskinizde. Kendi sağlayıcı anahtarlarınız cihazda şifrelenir ve bulutla eşitlenmez. Bu anahtarlarla model istekleri cihazınızdan doğrudan sağlayıcıya gider. Yerleşik Orkas modeli, Orkas’ın yönettiği hizmeti kullanır. Hazır kurulumlu sürümde isteğe bağlı bulut eşitleme ve paylaşılan projeler, seçili verileri Orkas sunucularında saklar. [Güvenlik ve veri işleme →](https://orkas.ai/security/?source=gh-orkas)

**Orkas çevrimdışı çalışır mı?**
Kaynak koddan derlenen sürüm yerel bir model uç noktasıyla tamamen çevrimdışı çalışabilir. Hazır kurulumlu sürümde oturum açmak, bulut modellerini kullanmak içinse ağ bağlantısı gerekir.

**Bilgisayarım kapalıyken çalışmaya devam eder mi?**
Hayır. Orkas bilgisayarınızda çalıştığı için otomatik ilerleme ve otomasyonlar sırasında bilgisayarınızın uyanık ve Orkas’ın açık olması gerekir. 1.9 sürümünden itibaren bilgisayar uyandığında veya Orkas açıldığında her otomasyon son 12 saat içinde kaçırdığı en son çalıştırmayı telafi eder.

**Uygulama oluşturup yayımlayabilir miyim?**
Evet. Orkas içinde çalışan yerel uygulamalar ücretsizdir. Herkese açık bağlantıyla bir web uygulaması yayımlamak ücretli plan gerektirir (Lite: 5, Pro: 8, Max: 15 uygulama). Yayımlanan web uygulamaları Orkas içindeki özelliklerin tamamını içermez.

**Orkas hesabı gerekiyor mu?**
Hazır kurulumlu masaüstü sürümü ilk açılışta oturum açmanızı ister. Bu depodan derlenen sürümde hesap katmanı bulunmaz; uygulama doğrudan açılır.

**Orkas, Claude Code’u ve diğer CLI ajanlarını çalıştırabilir mi?**
Evet. Beş harici CLI ajanını yerel alt süreç olarak çalıştırabilir: kodlama ajanları Claude Code, Codex ve OpenCode ile kişisel ajanlar OpenClaw ve Hermes-Agent. HyperFrames gibi açık kaynak araçlarını da aynı sohbet üzerinden yönetebilirsiniz.

**Orkas’ın Claude Code, Codex, CrewAI ve LangChain’den farkı nedir?**
Claude Code ve Codex birer kodlama ajanıdır; Orkas ikisini de aynı ekipte çalıştırabilir. CrewAI ve LangChain kodla kullanılan çerçevelerdir. Orkas, Commander’ın uzmanları ve CLI ajanlarınızı koordine ettiği, seçtiğiniz model sağlayıcısıyla çalışabilen açık kaynaklı bir masaüstü uygulamasıdır. Verileri ve anahtarları cihazda tutar. [Ayrıntılı karşılaştırmalara](https://orkas.ai/compare/?source=gh-orkas) bakın.

**Orkas hangi platformları destekliyor?**
macOS 12+ (Apple Silicon ve Intel) ve Windows 10+ için hazır kurulum programları var. glibc 2.34+ kullanan Linux x64/arm64 sistemlerinde şu anda kaynak koddan çalışır; henüz kurulum programı yoktur. Linux’ta yerel konuşma tanıma için ilk açılışta sabitlenmiş bir whisper.cpp sürümü hazırlanır. Alpine ve diğer musl tabanlı dağıtımlar desteklenmez. Kaynak koddan başlatmak için Node 22.12+ gerekir. Python 3 ve C/C++ derleme araçları, ancak yerel bir npm paketi için uyumlu hazır ikili dosya bulunmaz ve paketin cihazda yeniden derlenmesi gerekirse kullanılır.

**Orkas ücretsiz ve açık kaynaklı mı?**
Evet. Uygulama MIT lisanslıdır ve ücretsiz kullanılabilir. Hazır kurulumlu sürüm yerleşik Orkas modeli için 500 kredi içerir. Aylık 11,99 ABD dolarından başlayan ücretli planlar aylık kredi, bulut eşitleme, daha fazla paylaşılan proje ve uygulama yayımlama sunar. Kendi anahtarınızı kullanırsanız model kullanımını sağlayıcınız faturalandırır; Orkas ek ücret almaz. [Fiyatlandırma →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Lisans

[MIT](./LICENSE)
