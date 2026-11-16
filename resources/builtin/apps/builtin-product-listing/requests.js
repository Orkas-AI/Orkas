/* User-selected task requests, never resident Agent instructions. */
(function (root) {
    'use strict';
    const requests = {
        copy: 'Create a product listing draft for the channel and target language in the attached product snapshot. Use confirmed facts only; identify missing information instead of inventing specifications, certifications or claims. Return a JSON object with title, description and bullets (an array of strings). Do not publish or modify a store.',
        images: 'Create product images using the attached product snapshot and reference assets. Preserve the actual product identity and confirmed specifications. Propose the image plan and expected generation cost before paid production. Save the final image files. Do not publish or modify a store.',
        video: 'Create a product video using the attached product snapshot and selected assets. Follow its target language, channel, aspect ratio and duration. Propose the script, storyboard and expected generation cost before paid production. Save the final video file. Do not publish or modify a store.',
        extract: 'Extract product facts from the source URL in the attached product snapshot. Return a JSON object with name, description, sku, price and facts (a string). Leave unavailable fields empty. Do not infer certifications, performance or stock; do not modify a store.'
    };
    if (typeof module === 'object' && module.exports)
        module.exports = requests;
    else
        root.ListingRequests = Object.freeze(requests);
})(typeof window === 'object' ? window : globalThis);
