const { PERPLEXITY_API_KEY, PERPLEXITY_AVAILABLE } = require("./config");

let perplexityClient = null;

if (PERPLEXITY_AVAILABLE) {
  try {
    const { OpenAI } = require("openai");
    perplexityClient = new OpenAI({
      apiKey: PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai",
    });
  } catch (e) {
    console.error("⚠️  Perplexity API not available:", e.message);
  }
}

function parseSubtitleBlock(block, isVtt = false) {
  const lines = block.trim().split("\n");
  if (lines.length < 3) return null;

  let startIdx = 0;
  if (isVtt && !lines[0].includes("-->")) {
    startIdx = 1;
  }
  if (!isVtt) {
    startIdx = 1;
  }

  if (startIdx >= lines.length) return null;

  const timestampLine = lines[startIdx];
  const textLines = lines.slice(startIdx + 1);
  const text = textLines.join("\n");

  return {
    timestamp: timestampLine,
    text: text,
  };
}

/**
 * Translate subtitles to Hinglish (mix of Hindi Devanagari + English)
 */
async function translateSubtitles(subtitleText, isVtt = false) {
  if (!subtitleText || !PERPLEXITY_AVAILABLE || !perplexityClient) {
    return subtitleText;
  }

  const separator = "\n\n";
  const blocks = subtitleText.split(separator);

  const parsedBlocks = [];
  let header = null;
  const textsToTranslate = [];
  const textIndices = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.trim()) continue;

    if (isVtt && i === 0 && block.trim().startsWith("WEBVTT")) {
      header = block;
      parsedBlocks.push({ type: "header", content: block });
      continue;
    }

    const parsed = parseSubtitleBlock(block, isVtt);
    if (!parsed) {
      parsedBlocks.push({ type: "raw", content: block });
      continue;
    }

    parsedBlocks.push({
      type: "subtitle",
      timestamp: parsed.timestamp,
      text: parsed.text,
      originalBlock: block,
    });
    textsToTranslate.push(parsed.text);
    textIndices.push(parsedBlocks.length - 1);
  }

  if (textsToTranslate.length > 0) {
    console.log(`🌐 Translating ${textsToTranslate.length} subtitle blocks to Hinglish...`);

    const batchText = textsToTranslate
      .map((text, i) => `[${i + 1}] ${text}`)
      .join("\n---SUBTITLE---\n");

    try {
      const prompt = `DO NOT use internet search. Use only your internal knowledge for this translation task.
ROLE
You are an expert linguistic decoder specializing in Hinglish (Hindi + English) audio transcription.
The user has uploaded a video with Hinglish audio, but it was transcribed using an AI that **only understands English**.
This results in "Phonetic Hallucinations" where Hindi sounds are forced into English words (e.g., "Bohot" becomes "Boat", "Kara" becomes "Car rack a").

GOAL
Your task is to read the "Gibberish English" and reconstruct the original natural Hinglish conversation.

PHONETIC MAPPING RULES (CRITICAL)
1. Sound Matching: Look for English words that sound like Hindi words.
   - "Boat" -> usually means "Bohot" (very/a lot)
   - "Key" -> usually means "Ki"
   - "Two/To" -> usually means "Tu" (you)
   - "With eye a" -> usually means "Uthaya"
   - "Is lee a" -> usually means "Isliye" (therefore)
   - "Ray/Ray by" -> usually means "Re/Arey bhai"
2. False Friends: Be careful of English words that are valid but incorrect in context.
   - If you see "Men" before a verb, it is likely "Main" (I).
   - If you see "Hay/Hey" at the end of a sentence, it is likely "Hai" (is).
3. Preserve English Nouns: Real English words used in Hinglish (Phone, Market, Traffic, Late, Tension) MUST be kept as English. Do not translate "Market" to "Bazaar".

EXAMPLES
Input: "A ray by, sun na. Many call car rack a tha."
Reasoning: "A ray by" sounds like "Arey bhai". "Many" sounds like "Maine". "Car rack a" sounds like "Kara".
Output: "Arey bhai, sun na. Maine call kara tha."

Input: "Market may boat traffic tha, is lee a late hoe gay a."
Reasoning: "May" -> "Mein". "Boat" -> "Bohot". "Is lee a" -> "Isliye". "Hoe gay a" -> "Ho gaya".
Output: "Market mein bohot traffic tha, isliye late ho gaya."

Input: "Please tension mutt lay."
Reasoning: "Mutt lay" rhymes with "Mat le".
Output: "Please tension mat le."

FORMATTING RULES
1. Preserve the numbering [1], [2], etc. for each subtitle
2. Separate each translated subtitle with ---SUBTITLE---
3. ONLY return the translated texts with their numbers, nothing else

Subtitles to convert:
${batchText}`;

      const completion = await perplexityClient.chat.completions.create({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content:
              "You are a translation assistant. Do not use internet search. Respond only with translations.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const translatedBatch = completion.choices[0].message.content.trim();

      const translatedTexts = [];
      for (const part of translatedBatch.split("---SUBTITLE---")) {
        const trimmed = part.trim();
        if (trimmed) {
          const text = trimmed.replace(/^\[\d+\]\s*/, "");
          translatedTexts.push(text.trim());
        }
      }

      for (let idx = 0; idx < textIndices.length; idx++) {
        if (idx < translatedTexts.length) {
          parsedBlocks[textIndices[idx]].text = translatedTexts[idx];
        }
      }

      console.log(`✓ Hinglish translation complete (${translatedTexts.length} blocks)`);
    } catch (e) {
      console.error(`⚠️  Perplexity Hinglish translation failed: ${e.message}`);
    }
  }

  return reconstructSubtitles(parsedBlocks, isVtt, header);
}

/**
 * Translate subtitles to Hindi Devanagari script (full Hindi)
 */
async function translateToHindiScript(subtitleText, isVtt = false) {
  if (!subtitleText || !PERPLEXITY_AVAILABLE || !perplexityClient) {
    return subtitleText;
  }

  const separator = "\n\n";
  const blocks = subtitleText.split(separator);

  const parsedBlocks = [];
  let header = null;
  const textsToTranslate = [];
  const textIndices = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.trim()) continue;

    if (isVtt && i === 0 && block.trim().startsWith("WEBVTT")) {
      header = block;
      parsedBlocks.push({ type: "header", content: block });
      continue;
    }

    const parsed = parseSubtitleBlock(block, isVtt);
    if (!parsed) {
      parsedBlocks.push({ type: "raw", content: block });
      continue;
    }

    parsedBlocks.push({
      type: "subtitle",
      timestamp: parsed.timestamp,
      text: parsed.text,
      originalBlock: block,
    });
    textsToTranslate.push(parsed.text);
    textIndices.push(parsedBlocks.length - 1);
  }

  if (textsToTranslate.length > 0) {
    console.log(`🌐 Translating ${textsToTranslate.length} subtitle blocks to Hindi Devanagari...`);

    const batchText = textsToTranslate
      .map((text, i) => `[${i + 1}] ${text}`)
      .join("\n---SUBTITLE---\n");

    try {
      const prompt = `DO NOT use internet search. Use only your internal knowledge for this translation task.

Translate the following subtitle texts to proper Hindi in Devanagari script.

RULES:
1. Translate EVERYTHING to Hindi Devanagari script
2. Use proper, natural Hindi grammar and vocabulary
3. Make it sound like native Hindi, not transliterated English
4. Preserve the numbering [1], [2], etc. for each subtitle
5. Separate each translated subtitle with ---SUBTITLE---
6. ONLY return the translated texts with their numbers, nothing else

Subtitles to translate:
${batchText}`;

      const completion = await perplexityClient.chat.completions.create({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content:
              "You are a Hindi translation assistant. Do not use internet search. Respond only with translations.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const translatedBatch = completion.choices[0].message.content.trim();

      const translatedTexts = [];
      for (const part of translatedBatch.split("---SUBTITLE---")) {
        const trimmed = part.trim();
        if (trimmed) {
          const text = trimmed.replace(/^\[\d+\]\s*/, "");
          translatedTexts.push(text.trim());
        }
      }

      for (let idx = 0; idx < textIndices.length; idx++) {
        if (idx < translatedTexts.length) {
          parsedBlocks[textIndices[idx]].text = translatedTexts[idx];
        }
      }

      console.log(`✓ Hindi script translation complete (${translatedTexts.length} blocks)`);
    } catch (e) {
      console.error(`⚠️  Perplexity Hindi translation failed: ${e.message}`);
    }
  }

  return reconstructSubtitles(parsedBlocks, isVtt, header);
}

function reconstructSubtitles(parsedBlocks, isVtt, header) {
  const resultBlocks = [];

  for (const blockData of parsedBlocks) {
    if (blockData.type === "header") {
      if (!isVtt) continue;
      resultBlocks.push(blockData.content);
    } else if (blockData.type === "raw") {
      resultBlocks.push(blockData.content);
    } else if (blockData.type === "subtitle") {
      let reconstructed;
      if (isVtt) {
        reconstructed = `${blockData.timestamp}\n${blockData.text}`;
      } else {
        const seqMatch = blockData.originalBlock.match(/^(\d+)\n/);
        if (seqMatch) {
          const seqNum = seqMatch[1];
          reconstructed = `${seqNum}\n${blockData.timestamp}\n${blockData.text}`;
        } else {
          reconstructed = `${blockData.timestamp}\n${blockData.text}`;
        }
      }
      resultBlocks.push(reconstructed);
    }
  }

  let result = resultBlocks.join("\n\n");

  if (header && isVtt && !result.startsWith("WEBVTT")) {
    result = header + "\n\n" + result;
  }

  return result;
}

function isPerplexityAvailable() {
  return PERPLEXITY_AVAILABLE && perplexityClient !== null;
}

module.exports = {
  translateSubtitles,
  translateToHindiScript,
  isPerplexityAvailable,
};
