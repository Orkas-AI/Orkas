# Presenter and creator-style videos

Read when a person talks to camera about a product or business: a generated
presenter (口播, 数字人带货), a creator-style review, unboxing, try-on or
tutorial. Lines, look lines, key images and lip-synced sound follow
[short-film.md](short-film.md); product facts follow [ecommerce.md](ecommerce.md);
the product's appearance follows
[product fidelity](@skill/video-studio/references/product-fidelity.md).

## The script

- Write the whole monologue first, then split it at sentence breaks into the
  clips that will carry it. Joined back together, the pieces read as the same
  monologue, word for word. Use as few clips as the length allows.
- The first line is the hook and is spoken within the first three seconds.
  Each later line talks about what its own clip shows; words that describe
  something off screen read as a voice pasted over the wrong footage.
- Keep a natural pace and check it with
  [script timing](@skill/video-studio/references/script-timing.md); when a line
  runs long, cut words rather than speed up the voice.
- A generated presenter has not used the product. It can state the product's
  facts, show it working and voice the offer, but not claim experience ("I've
  used it for two weeks", "my skin cleared up") or speak as a customer.
- Captions carry the spoken words; do not repeat the same line in large text.

## The presenter

- Make one key image and reuse it on every clip: head and shoulders at arm's
  length, looking into the lens, natural light, hands empty. Describe the face
  feature by feature in the look line rather than with adjectives.
Reuse the exact supplied photo when its framing already works for the shot. Use the configured image service when an edited reference is needed.
- Plain clothes without text or logos, in a colour that sits well with the
  product. Set the scene where the product is really used, and keep to two or
  three settings.
- Count hands. A presenter holding a phone has one free hand; give it one job.

## The product in hand

- Write one product line (materials, real size, two to five visible features,
  how it works) and paste it word for word into every prompt. Do not write the
  label's text into the prompt; the model redraws words wrong.
- Pass the real product image as a reference with the presenter's key image on
  every clip. Show only the sides the real images show, at true size; frame
  tighter rather than enlarging it.
- Opening, putting on or using up happens on a cut and does not reverse later.

## Making the clips

- Each clip holds a few short beats, each one action, at the longest length the
  service allows. Pass references rather than a first frame so the same person
  and product carry across clips, and join clips with hard cuts.
- Give each beat a moment with the mouth closed while the hands work, and put
  a product close-up or a scene of use between talking clips. It shows the
  product and hides the joins; avoid three talking shots of the same framing
  in a row.
- The presenter's voice can change between separately generated clips. Listen
  across the joins; if it changes, use one voice-over from `generate_speech`
  over shots where the mouth is not the focus instead of mixing voices.
- Keep captions clear of the mouth and chin.

## Checks

Before delivering, look at the joins and the talking shots: mouth timing,
smearing at the jaw or face edge, the number of hands, the product's shape,
colour and label against the real image, and whether the voice matches
across clips. Name anything kept in the reply.

A video with a generated person or voice may need an AI label where it is
published: Chinese rules require a visible one, Douyin and TikTok Shop ask
sellers to label AI content and virtual presenters, and Amazon uses a metadata
tag for generated people. Say so in the reply and offer to add a small visible
label.
