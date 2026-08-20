const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();


// ======================================================
// CONFIG
// ======================================================

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});


// ======================================================
// GAIA KNOWLEDGE BASE
// ======================================================

const GAIA_FILE_SEARCH_STORE =
  process.env.GAIA_FILE_SEARCH_STORE ||
  "fileSearchStores/gaia-knowledge-base-dl0ni2f6nvpw";


// ======================================================
// MODEL
// ======================================================

const GEMINI_MODEL = "gemini-3.6-flash";


// ======================================================
// AI SESSION
// ======================================================

// Chỉ user đã bấm AIサポート mới được AI trả lời
const aiSessions = new Map();

// Lịch sử hội thoại
const conversations = new Map();


// ======================================================
// HELPERS
// ======================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


// ======================================================
// RETRY GEMINI
// ======================================================

async function runWithRetry(task, label) {

  try {

    return await task();

  } catch (error1) {

    console.error(`${label} - FIRST ATTEMPT FAILED`);
    console.error("Message:", error1.message);

    console.log("WAITING 2 SECONDS...");

    await sleep(2000);

  }


  try {

    return await task();

  } catch (error2) {

    console.error(`${label} - SECOND ATTEMPT FAILED`);
    console.error("Message:", error2.message);

    throw error2;

  }

}


// ======================================================
// EXTRACT FILE SEARCH GROUNDING
// ======================================================

function getFileSearchGrounding(response) {

  const metadata =
    response?.candidates?.[0]?.groundingMetadata;

  const chunks =
    metadata?.groundingChunks || [];

  const retrievedChunks =
    chunks.filter((chunk) => {
      return (
        chunk?.retrievedContext &&
        chunk.retrievedContext.text
      );
    });

  return {
    metadata,
    retrievedChunks
  };

}


// ======================================================
// EXTRACT GOOGLE SEARCH SOURCES
// ======================================================

function getWebSources(response) {

  const metadata =
    response?.candidates?.[0]?.groundingMetadata;

  const chunks =
    metadata?.groundingChunks || [];

  const sources = [];

  for (const chunk of chunks) {

    if (
      chunk?.web?.uri &&
      chunk?.web?.title
    ) {

      sources.push({
        title: chunk.web.title,
        uri: chunk.web.uri
      });

    }

  }

  // loại bỏ nguồn trùng
  const uniqueSources = [];

  const seen = new Set();

  for (const source of sources) {

    if (!seen.has(source.uri)) {

      seen.add(source.uri);

      uniqueSources.push(source);

    }

  }

  return uniqueSources.slice(0, 3);

}


// ======================================================
// CREATE CONVERSATION TEXT
// ======================================================

function createConversationText(history) {

  return history
    .map((item) => {

      if (item.role === "assistant") {

        return `AI: ${item.text}`;

      }

      return `User: ${item.text}`;

    })
    .join("\n\n");

}


// ======================================================
// STEP 1
// SEARCH GAIA KNOWLEDGE BASE
// ======================================================

async function searchGaiaKnowledge(
  userMessage,
  conversationText
) {

  const prompt = `
あなたは株式会社ガイア国際センターの
「Gaia AI Support」です。

まずGaia Knowledge Baseの情報だけを使って、
ユーザーの質問に回答できるか確認してください。


==================================================
【最重要ルール】
==================================================

Gaia Knowledge Baseに、
ユーザーの質問に直接関係する情報がある場合だけ、
その情報を使って回答してください。

関連情報がない場合、
または会社名・対象者などが一致しない場合は、

NO_GAIA_MATCH

この文字列だけを出力してください。


==================================================
【絶対にしてはいけないこと】
==================================================

・別会社の情報を流用しない
・会社名が違う情報を使わない
・Gaia Knowledge Baseにない情報を推測しない
・一般知識でGaiaの会社情報を補完しない


例えば、

Gaia Knowledge Base：
株式会社ガイア国際センター
給与支払日：翌月10日

ユーザー：
会社Aの給料日は？

この場合、

「翌月10日」と答えてはいけません。

必ず、

NO_GAIA_MATCH

としてください。


==================================================
【Gaia情報がある場合】
==================================================

Gaia Knowledge Baseに
明確に該当する情報がある場合は、
その情報だけを根拠にして回答してください。

回答はLINEで読みやすいように、
簡潔で分かりやすくしてください。

ユーザーが日本語なら日本語、
ベトナム語ならベトナム語、
その他の言語なら可能な限り同じ言語で回答してください。


==================================================
【これまでの会話】
==================================================

${conversationText}


==================================================
【最新の質問】
==================================================

${userMessage}
`;


  const response =
    await runWithRetry(

      () =>
        ai.models.generateContent({

          model: GEMINI_MODEL,

          contents: prompt,

          config: {

            tools: [
              {
                fileSearch: {
                  fileSearchStoreNames: [
                    GAIA_FILE_SEARCH_STORE
                  ]
                }
              }
            ]

          }

        }),

      "GAIA FILE SEARCH"

    );


  const text =
    response.text?.trim() || "";


  const grounding =
    getFileSearchGrounding(response);


  console.log(
    "GAIA RETRIEVED CHUNKS:",
    grounding.retrievedChunks.length
  );


  if (grounding.retrievedChunks.length > 0) {

    grounding.retrievedChunks.forEach(
      (chunk, index) => {

        console.log(
          `GAIA SOURCE ${index + 1}:`,
          chunk.retrievedContext.title || ""
        );

        console.log(
          chunk.retrievedContext.text
        );

      }
    );

  }


  // Gemini xác nhận không có thông tin phù hợp
  if (
    text === "NO_GAIA_MATCH" ||
    text.includes("NO_GAIA_MATCH")
  ) {

    return {
      found: false,
      text: ""
    };

  }


  // Không retrieve được tài liệu nào
  if (
    grounding.retrievedChunks.length === 0
  ) {

    return {
      found: false,
      text: ""
    };

  }


  return {
    found: true,
    text: text
  };

}


// ======================================================
// STEP 2
// GOOGLE SEARCH
// ======================================================

async function searchInternet(
  userMessage,
  conversationText
) {

  const prompt = `
あなたは株式会社ガイア国際センターの
「Gaia AI Support」です。

Gaia Knowledge Baseでは、
ユーザーの質問に直接回答できる情報が
見つかりませんでした。

これからGoogle Searchを使って、
信頼できる外部情報を確認して回答してください。


==================================================
【検索ルール】
==================================================

1.
最新情報が必要な場合は
Google Searchの結果を優先してください。

2.
VISA、在留資格、税金、年金、
社会保険、行政制度などは、
できるだけ公的機関・公式情報を優先してください。

3.
JLPTなどの試験情報は、
可能な限り公式サイトを優先してください。

4.
会社独自の給与日、賞与額、
勤務シフト、寮費、社内ルールなどについては、
インターネットから推測してはいけません。

そのような質問で確実な情報が確認できない場合は、

「Gaiaの登録情報では確認できませんでした」

と伝えてください。

5.
確認できないことを作らないでください。

6.
情報が複数ある場合は、
信頼性の高い情報を優先してください。

7.
ユーザーが日本語なら日本語、
ベトナム語ならベトナム語、
その他の言語なら可能な限り同じ言語で回答してください。

8.
LINEで読みやすいように、
必要以上に長い回答は避けてください。

9.
質問に直接答えてください。

10.
必要であれば、
回答の最後に確認先を案内してください。


==================================================
【これまでの会話】
==================================================

${conversationText}


==================================================
【ユーザーの質問】
==================================================

${userMessage}
`;


  const response =
    await runWithRetry(

      () =>
        ai.models.generateContent({

          model: GEMINI_MODEL,

          contents: prompt,

          config: {

            tools: [
              {
                googleSearch: {}
              }
            ]

          }

        }),

      "GOOGLE SEARCH"

    );


  const text =
    response.text?.trim() || "";


  const sources =
    getWebSources(response);


  return {
    text,
    sources
  };

}


// ======================================================
// FORMAT WEB ANSWER
// ======================================================

function formatWebAnswer(
  answer,
  sources
) {

  let text =
    "🌐 Gaiaの登録情報に該当する情報がなかったため、外部情報を確認して回答します。\n\n" +
    answer;


  if (
    sources &&
    sources.length > 0
  ) {

    text += "\n\n【参考情報】";

    sources.forEach(
      (source) => {

        text +=
          `\n・${source.title}\n${source.uri}`;

      }
    );

  }


  return text;

}


// ======================================================
// LINE WEBHOOK
// ======================================================

app.post(

  "/webhook",


  // --------------------------------------------------
  // REQUEST LOG
  // --------------------------------------------------

  (req, res, next) => {

    console.log(
      "================================="
    );

    console.log(
      "LINE WEBHOOK REQUEST RECEIVED"
    );

    console.log(
      "Method:",
      req.method
    );

    console.log(
      "URL:",
      req.url
    );

    console.log(
      "User-Agent:",
      req.headers["user-agent"]
    );

    console.log(
      "Has LINE Signature:",
      !!req.headers["x-line-signature"]
    );

    console.log(
      "================================="
    );

    next();

  },


  // --------------------------------------------------
  // LINE SIGNATURE
  // --------------------------------------------------

  middleware(lineConfig),


  // --------------------------------------------------
  // MAIN
  // --------------------------------------------------

  async (req, res) => {

    console.log(
      "LINE WEBHOOK PASSED SIGNATURE CHECK"
    );


    try {

      await Promise.all(

        req.body.events.map(

          async (event) => {


            console.log(
              "---------------------------------"
            );

            console.log(
              "EVENT TYPE:",
              event.type
            );


            // ==================================================
            // POSTBACK
            // ==================================================

            if (
              event.type === "postback"
            ) {

              const data =
                event.postback.data;

              const userId =
                event.source.userId;


              console.log(
                "POSTBACK DATA:",
                data
              );


              // ==============================================
              // AI START
              // ==============================================

              if (
                data === "action=ai_start"
              ) {

                aiSessions.set(
                  userId,
                  true
                );


                conversations.set(
                  userId,
                  []
                );


                console.log(
                  "AI SESSION START:",
                  userId
                );


                await lineClient.replyMessage(

                  event.replyToken,

                  {

                    type: "text",

                    text:
                      "🤖 Gaia AIサポートです。\n\n" +

                      "まずGaiaに登録されている情報を確認します。\n" +

                      "Gaiaに情報がない場合は、必要に応じて外部情報を検索して回答します。\n\n" +

                      "VISA、給与、年金、特定技能、JLPT、マイナンバー、仕事や日本での生活などについて質問できます。\n\n" +

                      "ご質問を入力してください。\n\n" +

                      "AIを終了する場合は「AI終了」と入力してください。"

                  }

                );


                console.log(
                  "AI START MESSAGE SENT"
                );


                return;

              }


              return;

            }


            // ==================================================
            // TEXT MESSAGE ONLY
            // ==================================================

            if (
              event.type !== "message" ||
              event.message.type !== "text"
            ) {

              return;

            }


            const userId =
              event.source.userId;


            const userMessage =
              event.message.text.trim();


            console.log(
              "USER ID:",
              userId
            );

            console.log(
              "USER MESSAGE:",
              userMessage
            );


            // ==================================================
            // AI END
            // ==================================================

            if (
              userMessage === "AI終了"
            ) {

              aiSessions.set(
                userId,
                false
              );


              conversations.delete(
                userId
              );


              await lineClient.replyMessage(

                event.replyToken,

                {

                  type: "text",

                  text:
                    "AIサポートを終了しました。\n\n" +

                    "また利用する場合は「AIサポート」をタップしてください。"

                }

              );


              console.log(
                "AI SESSION END:",
                userId
              );


              return;

            }


            // ==================================================
            // AI NOT ACTIVE
            // ==================================================

            if (
              !aiSessions.get(userId)
            ) {

              console.log(
                "AI IS NOT ACTIVE - MESSAGE IGNORED"
              );

              return;

            }


            // ==================================================
            // HISTORY
            // ==================================================

            if (
              !conversations.has(userId)
            ) {

              conversations.set(
                userId,
                []
              );

            }


            const history =
              conversations.get(
                userId
              );


            history.push({

              role: "user",

              text: userMessage

            });


            // Chỉ giữ 12 đoạn hội thoại gần nhất
            if (
              history.length > 12
            ) {

              history.splice(
                0,
                history.length - 12
              );

            }


            const conversationText =
              createConversationText(
                history
              );


            let aiReply;


            // ==================================================
            // STEP 1:
            // GAIA KNOWLEDGE BASE
            // ==================================================

            try {

              console.log(
                "STEP 1: SEARCHING GAIA KNOWLEDGE BASE..."
              );


              const gaiaResult =
                await searchGaiaKnowledge(

                  userMessage,

                  conversationText

                );


              // ================================================
              // FOUND IN GAIA
              // ================================================

              if (
                gaiaResult.found
              ) {

                console.log(
                  "RESULT SOURCE: GAIA KNOWLEDGE BASE"
                );


                aiReply =
                  "📘 Gaiaの登録情報に基づいて回答します。\n\n" +
                  gaiaResult.text;

              }


              // ================================================
              // NOT FOUND → GOOGLE SEARCH
              // ================================================

              else {

                console.log(
                  "NO GAIA MATCH"
                );

                console.log(
                  "STEP 2: SEARCHING INTERNET..."
                );


                const webResult =
                  await searchInternet(

                    userMessage,

                    conversationText

                  );


                console.log(
                  "RESULT SOURCE: GOOGLE SEARCH"
                );


                aiReply =
                  formatWebAnswer(

                    webResult.text,

                    webResult.sources

                  );

              }


            } catch (error) {

              console.error(
                "================================="
              );

              console.error(
                "AI PROCESS ERROR"
              );

              console.error(
                "Name:",
                error.name
              );

              console.error(
                "Message:",
                error.message
              );

              console.error(
                "================================="
              );


              aiReply =
                "申し訳ありません。\n" +

                "現在AIサポートを利用できません。\n\n" +

                "少し時間をおいてから、もう一度お試しください。";

            }


            // ==================================================
            // EMPTY ANSWER
            // ==================================================

            if (
              !aiReply
            ) {

              aiReply =
                "申し訳ありません。\n" +

                "回答を取得できませんでした。";

            }


            // ==================================================
            // LINE LENGTH LIMIT SAFETY
            // ==================================================

            if (
              aiReply.length > 4500
            ) {

              aiReply =
                aiReply.substring(
                  0,
                  4500
                ) +

                "\n\n※回答が長いため、一部を省略しました。";

            }


            // ==================================================
            // SAVE AI ANSWER
            // ==================================================

            history.push({

              role: "assistant",

              text: aiReply

            });


            // ==================================================
            // SEND TO LINE
            // ==================================================

            try {

              await lineClient.replyMessage(

                event.replyToken,

                {

                  type: "text",

                  text: aiReply

                }

              );


              console.log(
                "AI RESPONSE SENT SUCCESSFULLY"
              );


            } catch (lineError) {

              console.error(
                "LINE REPLY ERROR"
              );

              console.error(
                lineError.message
              );

            }

          }

        )

      );


      console.log(
        "WEBHOOK PROCESSING COMPLETE"
      );


      res
        .status(200)
        .end();


    } catch (error) {

      console.error(
        "WEBHOOK PROCESSING ERROR"
      );

      console.error(
        error
      );


      res
        .status(500)
        .end();

    }

  }

);


// ======================================================
// ERROR HANDLER
// ======================================================

app.use(

  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "================================="
    );

    console.error(
      "WEBHOOK ERROR"
    );

    console.error(
      "Name:",
      err.name
    );

    console.error(
      "Message:",
      err.message
    );

    console.error(
      "================================="
    );


    if (
      !res.headersSent
    ) {

      res
        .status(500)
        .send(
          "Webhook error"
        );

    }

  }

);


// ======================================================
// SERVER CHECK
// ======================================================

app.get(

  "/",

  (
    req,
    res
  ) => {

    res.send(
      "Gaia LINE AI is running. Gaia Knowledge Base + Google Search enabled."
    );

  }

);


// ======================================================
// START SERVER
// ======================================================

const PORT =
  process.env.PORT ||
  3000;


app.listen(

  PORT,

  () => {

    console.log(
      `Gaia LINE AI server running on port ${PORT}`
    );

    console.log(
      `Model: ${GEMINI_MODEL}`
    );

    console.log(
      "Gaia Knowledge Base:"
    );

    console.log(
      GAIA_FILE_SEARCH_STORE
    );

    console.log(
      "Fallback: Google Search"
    );

  }

);
