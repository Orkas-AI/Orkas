"""Unit tests for deep-research compress. stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest

Covers BOTH matching shapes (topical passages we must keep/rank) and look-alike
non-matching shapes (stopword-only or surface-word overlap that must NOT rank as
relevant; near-but-not-duplicate chunks that must NOT be de-duped) per the repo's
text-processing test rule.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import compress  # noqa: E402
from compress import (  # noqa: E402
    MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, SMALL_CONTENT_CHARS,
    _dedup, _score, chunk_text, tokenize,
)

QUERY = "local first AI agent privacy"
QTERMS = set(tokenize(QUERY))   # {local, first, ai, agent, privacy}


class TokenizeAndScore(unittest.TestCase):
    def test_tokenize_drops_stopwords(self):
        self.assertEqual(set(tokenize("the AI agent and the data")), {"ai", "agent", "data"})

    def test_score_topical_beats_surface_overlap(self):
        relevant = tokenize("this local first ai agent protects user privacy on device")
        realestate = tokenize("the listing agent showed the house to prospective buyers")
        cov_rel, _ = _score(QTERMS, relevant)
        cov_re, _ = _score(QTERMS, realestate)
        self.assertGreater(cov_rel, cov_re)      # topical passage wins
        self.assertAlmostEqual(cov_re, 0.2, places=4)   # only "agent" matched (1/5)

    def test_score_zero_for_stopwords_only(self):
        cov, dens = _score(QTERMS, tokenize("the and for with is on by to"))
        self.assertEqual((cov, dens), (0.0, 0.0))

    def test_score_empty_query(self):
        self.assertEqual(_score(set(), tokenize("anything at all")), (0.0, 0.0))

    def test_tokenize_cjk_uses_bigrams(self):
        terms = set(tokenize("中文压缩预算是否严格"))
        self.assertIn("中文", terms)
        self.assertIn("压缩", terms)
        self.assertIn("预算", terms)
        self.assertNotIn("是否", terms)


class Chunking(unittest.TestCase):
    def test_paragraph_split_respects_cap(self):
        para = " ".join("Sentence number {} explains a distinct point clearly.".format(i)
                        for i in range(40))
        self.assertGreater(len(para), MAX_CHUNK_CHARS)
        chunks = chunk_text(para)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(all(len(c) <= MAX_CHUNK_CHARS for c in chunks))

    def test_blank_and_tiny_fragments_dropped(self):
        text = "short.\n\n" + ("\n\n") + "x" * (MIN_CHUNK_CHARS - 1)
        self.assertEqual(chunk_text(text), [])   # both fragments below MIN_CHUNK_CHARS

    def test_paragraphs_split_on_blank_lines(self):
        a = "A" * 120
        b = "B" * 120
        self.assertEqual(chunk_text(a + "\n\n" + b), [a, b])


class Dedup(unittest.TestCase):
    def _rec(self, chunk):
        return {"source": "s", "url": None, "title": None, "chunk": chunk, "chunk_index": 0}

    def test_exact_duplicate_dropped_first_wins(self):
        c = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
        kept, dropped = _dedup([self._rec(c), self._rec("  ALPHA beta gamma delta epsilon zeta eta theta iota kappa lambda mu  ")])
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 1)
        self.assertEqual(kept[0]["chunk"], c)   # first occurrence kept verbatim

    def test_near_duplicate_dropped(self):
        base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon"
        near = base.replace("upsilon", "phi")   # 1 of 20 tokens differ -> jaccard ~0.90
        kept, dropped = _dedup([self._rec(base), self._rec(near)])
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 1)

    def test_half_overlap_is_not_a_duplicate(self):
        a = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
        b = "alpha beta gamma delta epsilon lorem ipsum dolor sit amet"   # ~5/15 overlap
        kept, dropped = _dedup([self._rec(a), self._rec(b)])
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, 0)


# Distinct, topical vs off-topic vs pure-noise prose, each long enough (~750
# chars) that the total (> 2000) exercises the real compress path rather than the
# small-content skip. Built by joining sentences so spacing is single and each
# paragraph is a stable, assertable single chunk (< MAX_CHUNK_CHARS).
RELEVANT = " ".join([
    "Local-first AI agent systems keep user data on the device.",
    "They never stream the private conversation to a remote server, so privacy stays under the user's control.",
    "This local first design means the agent runs offline and the user's files are never uploaded.",
    "Researchers describe this on-device model as the core privacy guarantee of a trustworthy assistant.",
    "Because the ai agent processes prompts locally, sensitive documents remain private and are not exposed to any third party.",
    "The study reports that a local first architecture materially reduces the privacy attack surface for an autonomous agent.",
    "Keeping inference on device also removes the need to trust an operator with the raw prompt history.",
    "A local first agent can still sync encrypted state, but the plaintext never leaves the user's machine.",
    "The authors conclude that privacy and capability are not at odds when the ai agent runs where the data already lives.",
])
OFFTOPIC = " ".join([
    "The real estate agent showed the downtown house to several prospective buyers over the weekend.",
    "They negotiated the closing price and reviewed the mortgage paperwork with the bank before signing.",
    "The listing had been on the market for months, so the seller was eager to accept a reasonable offer.",
    "A home inspection team scheduled the final walkthrough for Monday morning after the appraisal cleared.",
    "The broker prepared the title transfer and the escrow documents for the county recorder that afternoon.",
    "Comparable sales in the neighborhood suggested the asking figure was slightly above market value.",
    "The buyers requested a small credit for a roof repair uncovered during the inspection contingency.",
    "Once the lender approved the financing, the parties set a closing date near the end of the month.",
])
NOISE = " ".join([
    "The chef simmered the tomato sauce for two hours, stirring in fresh basil and oregano throughout.",
    "He then plated the pasta with a generous helping of grated cheese and a slow drizzle of olive oil.",
    "A rustic loaf of sourdough came out of the wood oven with a crackling golden crust and soft crumb.",
    "Dessert was a lemon tart with a buttery shell, finished under the broiler for a caramelized top.",
    "The kitchen smelled of garlic and rosemary as the plates went out to the crowded dining room.",
    "A pot of espresso brewed slowly while the pastry cook folded butter into the laminated dough.",
    "Diners lingered over the cheese board, pairing aged gouda with quince paste and toasted walnuts.",
    "The sommelier recommended a crisp white to balance the richness of the braised short rib special.",
])


def _payload(**kw):
    base = {"query": QUERY, "sources": [
        {"id": "s1", "url": "https://a", "title": "A", "text": RELEVANT + "\n\n" + OFFTOPIC},
        {"id": "s2", "url": "https://b", "title": "B", "text": NOISE},
    ]}
    base.update(kw)
    return base


class CompressIntegration(unittest.TestCase):
    def test_runs_compress_path_not_skip(self):
        out = compress.compress(_payload())
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertGreater(out["stats"]["chars_in"], SMALL_CONTENT_CHARS)

    def test_relevant_ranked_first_and_noise_dropped(self):
        out = compress.compress(_payload())
        kept_texts = [k["chunk"] for k in out["kept"]]
        self.assertIn(RELEVANT, kept_texts)
        self.assertNotIn(NOISE, kept_texts)                 # coverage 0 -> dropped
        self.assertEqual(out["kept"][0]["chunk"], RELEVANT)  # highest coverage first
        scores = [k["score"] for k in out["kept"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertGreaterEqual(out["dropped_low_relevance"], 1)

    def test_budget_cap_keeps_only_top_chunk(self):
        out = compress.compress(_payload(max_chars=len(RELEVANT) + 20))
        self.assertEqual(out["stats"]["chunks_kept"], 1)
        self.assertEqual(out["kept"][0]["chunk"], RELEVANT)
        self.assertLessEqual(out["stats"]["chars_out"], len(RELEVANT) + 20)

    def test_per_source_cap(self):
        out = compress.compress(_payload(max_per_source=1))
        per = {}
        for k in out["kept"]:
            per[k["source"]] = per.get(k["source"], 0) + 1
        self.assertTrue(all(v <= 1 for v in per.values()))

    def test_small_content_skips_compression(self):
        out = compress.compress({"query": QUERY, "sources": [
            {"id": "s1", "url": "https://a", "title": "A", "text": "Tiny local ai agent note."}]})
        self.assertTrue(out["stats"]["skipped_compression"])
        self.assertEqual(out["kept"][0]["score"], None)
        self.assertEqual(out["kept"][0]["chunk"], "Tiny local ai agent note.")

    def test_no_query_skips_scoring(self):
        out = compress.compress({"query": "", "sources": _payload()["sources"]})
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertTrue(out["stats"]["skipped_scoring"])
        self.assertTrue(all(k["score"] is None for k in out["kept"]))
        self.assertLessEqual(out["stats"]["chars_out"], out["budget_chars"])

    def test_cjk_large_input_is_ranked_and_hard_bounded(self):
        relevant = "本研究分析中文压缩预算，要求所有输出严格遵守字符上限并保留关键证据。" * 80
        noise = "餐厅今天准备了面包、咖啡和水果，厨师随后整理了厨房。" * 80
        out = compress.compress({
            "query": "中文压缩预算如何严格执行",
            "max_chars": 1200,
            "sources": [
                {"id": "relevant", "text": relevant},
                {"id": "noise", "text": noise},
            ],
        })
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertTrue(out["kept"])
        self.assertEqual(out["kept"][0]["source"], "relevant")
        self.assertLessEqual(out["stats"]["chars_out"], 1200)

    def test_output_is_self_contained_without_host_rerank_candidates(self):
        out = compress.compress(_payload())
        self.assertNotIn("candidates", out)
        self.assertNotIn("semantic_candidates", out["stats"])
        self.assertTrue(out["kept"])

    def test_first_chunk_never_overruns_tiny_budget(self):
        out = compress.compress({
            "query": QUERY,
            "max_chars": 40,
            "sources": [{"id": "s1", "text": RELEVANT * 4}],
        })
        self.assertLessEqual(out["stats"]["chars_out"], 40)

    def test_dedup_counted_across_sources(self):
        p = _payload()
        p["sources"].append({"id": "s3", "url": "https://c", "title": "C", "text": RELEVANT})
        out = compress.compress(p)
        self.assertGreaterEqual(out["stats"]["deduped"], 1)
        self.assertEqual(sum(1 for k in out["kept"] if k["chunk"] == RELEVANT), 1)

    def test_input_caps_are_applied_and_reported(self):
        old = (compress.MAX_SOURCES, compress.MAX_SOURCE_CHARS, compress.MAX_TOTAL_INPUT_CHARS)
        try:
            compress.MAX_SOURCES = 3
            compress.MAX_SOURCE_CHARS = 100
            compress.MAX_TOTAL_INPUT_CHARS = 250
            sources = [{"id": "s{}".format(i), "text": "x" * 120} for i in range(5)]
            out = compress.compress({"query": "", "sources": sources})
        finally:
            (compress.MAX_SOURCES,
             compress.MAX_SOURCE_CHARS,
             compress.MAX_TOTAL_INPUT_CHARS) = old

        stats = out["stats"]
        self.assertTrue(stats["input_capped"])
        self.assertEqual(stats["sources"], 5)              # legacy field: valid input sources
        self.assertEqual(stats["sources_input"], 5)
        self.assertEqual(stats["sources_considered"], 3)
        self.assertEqual(stats["sources_dropped"], 2)
        self.assertEqual(stats["sources_truncated"], 3)
        self.assertEqual(stats["chars_input_raw"], 600)
        self.assertEqual(stats["chars_in"], 250)
        self.assertEqual(stats["chars_truncated"], 350)


if __name__ == "__main__":
    unittest.main()


# ── CJK (Chinese) fixtures — non-English behavior fixtures per the repo rule ──
# Same three-way split as the English set above: topical vs off-topic (智能体 vs
# real-estate 中介, mirroring the "agent" ambiguity) vs cooking noise. Each is a
# single paragraph under MAX_CHUNK_CHARS.

QUERY_ZH = "本地优先智能体的隐私保障"
RELEVANT_ZH = (
    "本地优先的智能体系统把用户数据完整保留在设备本地，模型推理全程不需要把私人对话上传到远程服务器。"
    "由于所有处理都发生在用户自己的机器上，敏感文档不会暴露给任何第三方服务，隐私始终掌握在用户手中。"
    "研究人员把这种端侧运行模式描述为可信助手最核心的隐私保障，也是本地优先架构的根本价值所在。"
    "报告指出，本地优先架构显著缩小了自主智能体面临的隐私攻击面，减少了对运营方的信任依赖。"
    "本地优先的智能体仍然可以同步加密后的状态，但明文内容永远不会离开用户的机器。"
)
OFFTOPIC_ZH = (
    "房产中介周末带着几组买家看了市中心的房子，双方就成交价格进行了多轮谈判。"
    "签约之前，银行审核了贷款材料并确认了首付比例，卖家急于接受一个合理的报价。"
    "验房团队把最终的交割检查安排在周一上午进行，经纪人当天下午准备好了产权过户和资金托管文件。"
    "同小区最近的成交记录显示，这套房源的挂牌价格略高于市场行情。"
)
NOISE_ZH = (
    "厨师把番茄酱汁小火慢炖了两个小时，期间不断加入新鲜罗勒和牛至调味。"
    "随后他把意面装盘，撒上厚厚一层擦碎的奶酪，再淋上少许橄榄油。"
    "木炉里烤出的乡村酸面包外壳金黄酥脆，内里松软，甜点是一只黄油挞皮的柠檬挞。"
    "厨房里弥漫着大蒜和迷迭香的香气，一盘盘菜被端进坐满客人的餐厅。"
)


class CjkCompression(unittest.TestCase):
    """Before CJK bigram tokenization a pure-Chinese query produced zero query
    terms (the whole corpus passed through uncompressed and unbudgeted) and CJK
    chunks scored 0 under a mixed-language query (all dropped as noise)."""

    def _zh_sources(self):
        return [
            {"id": "z1", "url": "https://zh-a", "title": "A",
             "text": RELEVANT_ZH + "\n\n" + OFFTOPIC_ZH},
            {"id": "z2", "url": "https://zh-b", "title": "B", "text": NOISE_ZH},
        ]

    def _run(self, payload):
        # The CJK fixtures are dense, so lower the small-content gate the same
        # way test_input_caps_are_applied_and_reported patches module caps.
        old = compress.SMALL_CONTENT_CHARS
        try:
            compress.SMALL_CONTENT_CHARS = 200
            return compress.compress(payload)
        finally:
            compress.SMALL_CONTENT_CHARS = old

    def test_tokenize_emits_cjk_bigrams(self):
        toks = tokenize("智能体")
        self.assertIn("智能", toks)
        self.assertIn("能体", toks)

    def test_tokenize_mixed_keeps_latin_and_cjk(self):
        toks = tokenize("AI 对就业的影响")
        self.assertIn("ai", toks)
        self.assertIn("就业", toks)
        self.assertIn("影响", toks)

    def test_pure_chinese_query_scores_instead_of_skipping(self):
        out = self._run({"query": QUERY_ZH, "sources": self._zh_sources()})
        self.assertFalse(out["stats"]["skipped_compression"])
        kept = [k["chunk"] for k in out["kept"]]
        self.assertIn(RELEVANT_ZH, kept)
        self.assertNotIn(NOISE_ZH, kept)                  # no overlap -> dropped
        self.assertEqual(out["kept"][0]["chunk"], RELEVANT_ZH)

    def test_mixed_language_query_keeps_chinese_evidence(self):
        out = self._run({"query": "AI 智能体的隐私保障", "sources": self._zh_sources()})
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertIn(RELEVANT_ZH, [k["chunk"] for k in out["kept"]])

    def test_short_chinese_fragment_survives_min_gate(self):
        zh = "本地优先的智能体系统把用户的全部数据保留在设备本地，天然保护用户隐私。"
        en = "Short latin fragment of same size."
        self.assertEqual(chunk_text(zh), [zh])    # CJK weighting keeps it
        self.assertEqual(chunk_text(en), [])      # latin gate unchanged

    def test_long_chinese_paragraph_splits_on_sentence_enders(self):
        sent = "本地优先的智能体在设备上完成推理并保护用户的隐私数据不外泄。"
        para = sent * 50    # ~1450 chars, no whitespace anywhere
        chunks = chunk_text(para)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c), MAX_CHUNK_CHARS)
            self.assertTrue(c.endswith("。"))     # sentence boundary, not mid-cut


class NoQueryPathBudget(unittest.TestCase):
    def test_no_query_path_respects_budget(self):
        # A no-content-term query still must not pass through unbounded.
        words = ["alpha", "bravo", "charlie", "delta", "echo",
                 "foxtrot", "golf", "hotel", "india", "juliet"]
        sources = [{"id": "s%d" % i, "text": ("%s metrics " % w) * 75}
                   for i, w in enumerate(words)]           # ~10 x 900+ chars
        out = compress.compress({"query": "", "sources": sources, "max_chars": 2000})
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertTrue(out["stats"]["skipped_scoring"])
        self.assertLessEqual(out["stats"]["chars_out"], 2000)
        self.assertLess(out["stats"]["chunks_kept"], len(sources))

    def test_skip_path_always_keeps_first_record(self):
        out = compress.compress({"query": "", "sources": [
            {"id": "s1", "text": "y" * 500}], "max_chars": 100})
        self.assertEqual(out["stats"]["chunks_kept"], 1)   # never emit nothing
