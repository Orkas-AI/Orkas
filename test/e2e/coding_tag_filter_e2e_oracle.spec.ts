import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const { selectTagFilters, tagCheckFailure } = createRequire(__filename)("../../eval/product-runtime-comparison/coding/oracles/tag-filter-controls.cjs");
test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });
let page: Page;
let browserErrors: string[];
test.beforeEach(async ({ page: current }) => {
  page = current; page.setDefaultTimeout(750); browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) browserErrors.push(message.text()); });
});
test.afterEach(() => { expect(browserErrors).toEqual([]); });

async function controls(markup: string, script = "") {
  await page.route("http://tag-controls.test/**", route => route.fulfill({ contentType: "text/html", body: `${markup}<script>
    const selected = new Set();
    function chooseTag(tag) { selected.add(tag); history.replaceState(null, '', '/items?tags=' + [...selected].join(',')); }
    ${script}
  </script>` }));
  await page.goto("http://tag-controls.test/items");
}

test.describe("tag acceptance drives accessible controls without prescribing layout", () => {
  for (const kind of ["checkbox", "buttons", "text"]) test(`retains the existing ${kind} filter journey`, async () => {
    const markup = kind === "checkbox"
      ? '<label>Filter by red<input type="checkbox" onchange="chooseTag(\'red\')"></label><label>Filter by blue<input type="checkbox" onchange="chooseTag(\'blue\')"></label>'
      : kind === "buttons"
        ? '<button onclick="chooseTag(\'red\')">red</button><button onclick="chooseTag(\'blue\')">blue</button>'
        : '<label>Filter tags<input onkeydown="if(event.key===\'Enter\') this.value.split(\',\').map(x=>x.trim()).forEach(chooseTag)"></label>';
    await controls(markup);
    await selectTagFilters(page);
    expect(new URL(page.url()).searchParams.get("tags")).toBe("red,blue");
  });

  for (const closes of [false, true]) test(`selects both tags through a dropdown (closes after selection: ${closes})`, async () => {
    await controls('<button id="trigger" aria-haspopup="menu" onclick="menu.hidden=false">Tags</button><div id="menu" role="menu" hidden><button role="menuitemcheckbox" aria-checked="false" onclick="pick(this)">red</button><button role="menuitemcheckbox" aria-checked="false" onclick="pick(this)">blue</button></div>', `
      function pick(button) {
        chooseTag(button.textContent); button.setAttribute('aria-checked', 'true');
        trigger.textContent = 'Tags ' + selected.size;
        menu.hidden = ${closes};
      }
      document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
    `);
    await selectTagFilters(page);
    expect(new URL(page.url()).searchParams.get("tags")).toBe("red,blue");
    expect(await page.getByRole("menu").isVisible()).toBe(false);
  });

  test("waits for an asynchronous route update before selecting the next dropdown tag", async () => {
    await controls('<button id="trigger" onclick="menu.hidden=false">Tags</button><div id="menu" role="menu" hidden><button role="menuitemcheckbox" aria-checked="false" onclick="pick(this)">red</button><button role="menuitemcheckbox" aria-checked="false" onclick="pick(this)">blue</button></div>', `
      function pick(button) {
        const next = [...selected, button.textContent];
        setTimeout(() => {
          selected.clear(); next.forEach(tag => selected.add(tag));
          history.replaceState(null, '', '/items?tags=' + next.join(','));
          button.setAttribute('aria-checked', 'true');
        }, 150);
      }
      document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
    `);
    await selectTagFilters(page);
    expect(new URL(page.url()).searchParams.get("tags")).toBe("red,blue");
  });

  for (const mode of ["missing", "inert", "partial"]) test(`does not award selection for ${mode} controls`, async () => {
    await controls(mode === "missing" ? '<p>No tag filtering</p>'
      : `<button onclick="${mode === "partial" ? "chooseTag('red')" : ""}">red</button><button>blue</button>`);
    await expect(selectTagFilters(page)).rejects.toThrow();
    expect(new URL(page.url()).searchParams.get("tags")).not.toBe("red,blue");
  });
});

for (const entry of ["create", "edit", "discarded"]) test(`tag delivery accepts persisted ${entry} entry and rejects discarded edits`, async () => {
  const { createTaggedItem } = createRequire(__filename)("../../eval/product-runtime-comparison/coding/oracles/tag-filter-controls.cjs");
  await controls(`<button onclick="openItem(false)">Add Item</button><table><tbody id="rows"></tbody></table>
    <button role="menuitem" id="edit" hidden onclick="openItem(true)">Edit Item</button>
    <dialog id="editor"><input id="title" placeholder="Title"><span id="tagField"></span><button onclick="saveItem()">Save</button></dialog>`, `
    function render() {
      const item = JSON.parse(localStorage.getItem('item') || 'null');
      rows.innerHTML = item ? '<tr><td>' + item.title + '</td><td>' + item.tags + '</td><td><button onclick="edit.hidden=false">Actions</button></td></tr>' : '';
    }
    function openItem(editing) {
      tagField.innerHTML = ${JSON.stringify(entry)} === 'create' || editing ? '<label>Tags<input id="tags"></label>' : '';
      const item = JSON.parse(localStorage.getItem('item') || 'null');
      document.getElementById('title').value = editing ? item.title : '';
      editor.showModal();
    }
    function saveItem() {
      localStorage.setItem('item', JSON.stringify({ title: document.getElementById('title').value, tags: ${JSON.stringify(entry)} === 'discarded' ? '' : document.getElementById('tags')?.value || '' }));
      editor.close(); render();
    }
    render();
  `);
  if (entry === "discarded") {
    const failure = await createTaggedItem(page, "Browser tagged item").catch(error => error);
    expect(tagCheckFailure('A06.delivery', failure)).toMatchObject({ pass: false, phase: 'outcome', selectorReviewRequired: false });
  }
  else expect(await createTaggedItem(page, "Browser tagged item")).toBe(entry === "create" ? "create-with-tags" : "create-then-edit");
});

test("waits for async button selection before the next click reads route state", async () => {
  await controls('<button onclick="pick(\'red\')">red</button><button onclick="pick(\'blue\')">blue</button>', `
    function pick(tag) {
      const next = [...selected, tag];
      setTimeout(() => { selected.clear(); next.forEach(chooseTag); }, 100);
    }
  `);
  await selectTagFilters(page);
  expect(new URL(page.url()).searchParams.get("tags")).toBe("red,blue");
});

for (const custom of [false, true]) for (const prefix of ["", "Filter by "]) {
  test(`accepts ${custom ? "role" : "native"} checkboxes named ${prefix || "plain"} with async route commits`, async () => {
    await controls(["red", "blue"].map(tag => custom
      ? `<label><button role="checkbox" aria-checked="false" onclick="this.setAttribute('aria-checked','true');pick('${tag}')"></button>${prefix}${tag}</label>`
      : `<label>${prefix}${tag}<input type="checkbox" onchange="pick('${tag}')"></label>`).join(""), `
      function pick(tag) {
        const next = [...selected, tag];
        setTimeout(() => { selected.clear(); next.forEach(chooseTag); }, 150);
      }
    `);
    await selectTagFilters(page);
    expect(new URL(page.url()).searchParams.get("tags")).toBe("red,blue");
  });
}

for (const mode of ["inert", "partial"]) test(`rejects ${mode} plain checkbox filtering`, async () => {
  await controls(`<label>red<input type="checkbox" onchange="${mode === "partial" ? "chooseTag('red')" : ""}"></label><label>blue<input type="checkbox"></label>`);
  await expect(selectTagFilters(page)).rejects.toThrow();
  expect(new URL(page.url()).searchParams.get("tags")).not.toBe("red,blue");
});

test("accepts a controlled checkbox whose checked state follows an async route commit", async () => {
  await controls(['red', 'blue'].map(tag => `<label><button role="checkbox" aria-checked="false" onclick="pick(this,'${tag}')"></button>${tag}</label>`).join(''), `
    function pick(button, tag) {
      const next = [...selected, tag];
      setTimeout(() => { selected.clear(); next.forEach(chooseTag); button.setAttribute('aria-checked', 'true'); }, 150);
    }
  `);
  await selectTagFilters(page);
  expect(new URL(page.url()).searchParams.get('tags')).toBe('red,blue');
  await expect(page.getByRole('checkbox', { name: 'blue', exact: true })).toBeChecked();
});

test("uses reviewed badge bindings and waits through a filter-region remount", async () => {
  await controls('<p>red</p><p>blue</p><button>red</button><div id="filters"></div>', `
    function render() {
      filters.innerHTML = ['red', 'blue'].map(tag => '<span data-tag="' + tag + '" onclick="pick(this.dataset.tag)">' + tag + '</span>').join('');
    }
    function pick(tag) {
      chooseTag(tag);
      filters.innerHTML = '';
      setTimeout(render, 100);
    }
    render();
  `);
  await selectTagFilters(page, { red: '#filters [data-tag="red"]', blue: '#filters [data-tag="blue"]' });
  expect(new URL(page.url()).searchParams.get('tags')).toBe('red,blue');
});

for (const mode of ['missing', 'inert', 'partial', 'ambiguous']) {
  test(`reviewed bindings do not accept ${mode} filter controls`, async () => {
    await controls(mode === 'missing' ? '<p>red blue</p>'
      : `<span class="red" onclick="${mode === 'partial' ? "chooseTag('red')" : ''}">red</span><span class="blue">blue</span>${mode === 'ambiguous' ? '<span class="red">red</span>' : ''}`);
    const failure = await selectTagFilters(page, { red: '.red', blue: '.blue' }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.oraclePhase ?? 'outcome').toBe(['missing', 'ambiguous'].includes(mode) ? 'entry' : 'outcome');
    expect(tagCheckFailure('A06.filter', failure)).toMatchObject({ pass: false,
      selectorReviewRequired: ['missing', 'ambiguous'].includes(mode) });
    expect(new URL(page.url()).searchParams.get('tags')).not.toBe('red,blue');
  });
}
