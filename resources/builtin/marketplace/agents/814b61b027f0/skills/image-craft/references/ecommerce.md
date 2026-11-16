# Ecommerce images

Read only for product listing or sales-creative work after route lock. This reference supplements the selected image route; it does not require the general art-direction pass for a mechanical edit.

## Choose the image's job

For new creative work, use `brief.purpose` and `art_direction.one_job` to decide what the buyer should understand from this image. Choose from the request and available facts rather than treating every product image as a poster with a headline. These are examples, not mandatory layouts:

| Use | Visual decision |
| --- | --- |
| Listing hero | Make the selected product and variant easy to recognize; choose the requested or appropriate background and keep supporting copy subordinate. A white background is not a universal requirement. |
| Campaign or lifestyle image | Build a subject-specific setting and visual idea around the product. Connect the scene, light and materials to the intended audience and message instead of adding unrelated decoration. |
| Detail image | Show a visible feature or material with a useful close-up from the supplied source; make the detail's relation to the whole product understandable. |
| Specification or comparison image | Help the buyer read supplied dimensions, quantities or variant differences, with each fact bound to the right product. Do not invent unseen views to make a diagram. |

When the request leaves the purpose open, choose a useful supported direction and proceed under the existing clarification rules. A price-only edit, exact reproduction or requested preservation of framing does not authorize new art direction, enlargement, cropping or additional copy.

## Read the source before borrowing its look

Identify what each supplied image actually contains before assigning its existing reference role and preserve/may-change boundaries:

- **Product photograph:** distinguish the physical product from hands, props, source padding and surroundings. Use the visible product as identity evidence; do not assume its original staging is the requested design.
- **Packaging image:** distinguish the physical box and readable markings from the source canvas around them. Printed words, symbols and illustrations identify what the packaging shows; they do not verify unseen contents, accessories or operating behavior beyond that evidence.
- **Finished advertisement:** separate the product identity from its old headline, background and layout. For a new campaign, carry forward only the requested roles; do not inherit the old advertising composition by default. For a scoped edit or reproduction, preserve the user's declared whole-image attributes instead.
- **Style reference:** borrow only its assigned palette, lighting, materials or graphic language. It does not supply this SKU's appearance, claims or offer.

Put these decisions in the existing reference bindings and art direction, not a separate intake form or schema. If old copy covers part of a product, do not treat a model's reconstructed hidden detail as verified source pixels.

## Turn source facts into buyer-facing content

For a new product introduction where creative copy is allowed, select readable source facts or user-confirmed information that help the intended buyer identify the specific item and understand what this image is meant to show. Faithfully translate names and markings into the buyer's language when useful, retaining their meaning and status as source labeling. This does not verify unobserved performance or contents. Use that supported information in the existing brief and copy hierarchy before styling. Sparse evidence limits claims; it does not require replacing available product information with a generic category or notes about displaying the source. Omit unsupported benefits while keeping the supported introduction useful. Exact-copy, scoped-edit and reproduction constraints still take precedence.

## Product binding and fidelity

Bind each requested output to its selected SKU and variant, source asset, quantity, packaging text and supplied claims. Use the existing brief and reference preserve/may-change boundaries. When product appearance must remain exact, retain the original product pixels and compose the surroundings separately. Resolve conflicting product facts before producing the affected output.

When an opaque packshot carries its own background, match the surrounding composition to that background or use a verified product cutout. Check the silhouette and background joins: an unstyled rectangular patch pasted over an unrelated scene is unfinished compositing. Preserve the product pixels while repairing the surrounding treatment.

Judge the product's actual recognizability and label readability, not the size of its image element or surrounding source rectangle. Keep intentional negative space and user-protected framing. Keep titles, price blocks and decorative cards subordinate to the product when product recognition is the image's job, and check that hierarchy at thumbnail size. For composition asset handling, follow [source-region preparation](@skill/image-compose/references/photo-processing.md#source-region-before-placement).

## Worked creative decisions

Adapt the following relationships to the actual product and brief. Do not copy example objects, settings or copy into unrelated work. Compile the result through the existing image-craft prompt order and reference contract.

### A clear catalogue photograph

Input: a photograph of one amber glass mug, with the user requesting a white-background listing image and unchanged product appearance.

Direction: isolate the visible mug without changing its outline, handle, tint or markings. Keep the supplied view, allow room around the handle, and use a restrained contact shadow consistent with the source light. No promotional slogan is needed.

For a permitted semantic edit, a concrete prompt thesis is: "Use the supplied mug photograph as the product reference. Keep its outline, handle, amber tint and visible markings unchanged. Replace only the surroundings with a clean white studio background; ground the mug with a soft contact shadow matching the source light. Show one mug, in the supplied view, without added text or props." Exact-pixel work instead retains the source product through the selected composition route.

### A campaign from an existing advertisement

Input: an old flat advertisement containing a closed floral tea box; the user requests a new spring campaign while preserving the actual package.

Direction: use the box as identity evidence, with a warm cream and pale lilac paper setting, an offset plinth and side lighting compatible with the source. Reserve quiet space for the supplied headline. The new setting carries the seasonal idea; it does not prove ingredients, fragrance or health effects.

If an approved generated background is needed, its prompt can describe: "An empty warm-cream tabletop with a low pale-lilac paper plinth on the right, a softly folded paper backdrop and gentle window shadows. Leave clear space on the left for separately typeset copy. No product, packaging, logo or lettering." Compose the real package and exact copy separately, matching scale, perspective and shadow. With no approved generation, use available assets and authored shapes for the chosen composition rather than imitating a photographic scene with an untouched source rectangle.

### A useful detail or specification image

Input: a supplied bag photograph with a visible fastening detail and user-confirmed dimensions.

Direction: retain a whole-product view for orientation, pair it with a supported crop of the fastening, and place the exact supplied measurements beside the corresponding edges. Make the detail and numbers answer a buyer's question; do not add a hidden interior, invented hardware, durability claim or new measurement. Use deterministic labels and lines rather than asking a model to draw factual diagram text.

Technique references: [product-photography examples](https://github.com/ZeroLu/awesome-nanobanana-pro#4-e-commerce--virtual-studio), [product and campaign examples](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts), and [layer/mask controls](https://v7.invoke.ai/users-guide/canvas/layers-panel/). These illustrate visible decisions, not evidence of this product's facts or a requirement to use those models or tools.

## Product-fact inspection

Compare the delivered product image with its selected source for SKU, variant, label, included items and readable factual copy. Inspect label detail at the exported size: a readable source label can become illegible after scaling or cropping. Repair the affected composition without redrawing protected packaging. Report an unverified or mismatched product as such. Product-fact inspection does not enable scored design review for host-verified `is_generation:true` artifacts. When the route supplies no viewable candidate, state that visual product fidelity is unverified; do not invent an inspection result.
