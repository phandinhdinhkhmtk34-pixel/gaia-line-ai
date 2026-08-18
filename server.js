const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();


// ======================================================
// LINE CONFIG
// ======================================================

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);


// ======================================================
// GEMINI CONFIG
// ======================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});


// ======================================================
// GAIA KNOWLEDGE BASE
// ======================================================

// Gaia File Search Store
const GAIA_FILE_SEARCH_STORE =
  process.env.GAIA_FILE_SEARCH_STORE ||
  "fileSearchStores/gaia-knowledge-base-dl0ni2f6nvpw";


// ======================================================
// AI SESSION
// ======================================================

// User đã bật AIサポート
const aiSessions = new Map();

// Lưu lịch sử hội thoại
const conversations = new Map();


// ======================================================
// HELPER: SLEEP
// ======================================================

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};


// ======================================================
// HELPER: GET GROUNDING DATA
// ======================================================

function getGroundingInfo(response) {

  const groundingMetadata =
    response?.candidates?.[0]?.groundingMetadata;

  const groundingChunks =
    groundingMetadata?.groundingChunks || [];

  const retrievedChunks =
    groundingChunks.filter(
      (chunk) =>
        chunk &&
        chunk.retrievedContext &&
        chunk.retrievedContext.text
    );

  return {
    groundingMetadata,
    groundingChunks,
    retrievedChunks,
    grounded: retrievedChunks.length > 0
  };
}


// ======================================================
// HELPER: LOG GAIA SOURCES
// ======================================================

function logGaiaSources(retrievedChunks) {

  if (!retrievedChunks.length) {

    console.log(
      "GAIA KNOWLEDGE BASE: NO MATCHING CHUNKS"
    );

    return;
  }

  console.log(
    `GAIA KNOWLEDGE BASE: ${retrievedChunks.length} CHUNK(S) FOUND`
  );

  retrievedChunks.forEach(
    (chunk, index) => {

      const context =
        chunk.retrievedContext;

      console.log(
        `SOURCE ${index + 1}:`,
        context.title || "Unknown document"
      );

      console.log(
        "STORE:",
        context.fileSearchStore || ""
      );

      console.log(
        "TEXT:",
        context.text
      );

    }
  );
}


// ======================================================
// CALL GEMINI + GAIA FILE SEARCH
// ======================================================

async function callGeminiWithGaiaKnowledge(
  model,
  prompt
) {

  console.log(
    `CALLING MODEL WITH GAIA KNOWLEDGE: ${model}`
  );

  const response =
    await ai.models.generateContent({

      model: model,

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

    });


  const groundingInfo =
    getGroundingInfo(response);


  logGaiaSources(
    groundingInfo.retrievedChunks
  );


  return {

    text:
      response.text ||
      "",

    grounded:
      groundingInfo.grounded,

    groundingMetadata:
      groundingInfo.groundingMetadata,

    retrievedChunks:
      groundingInfo.retrievedChunks

  };
}


// ======================================================
// GEMINI RETRY + FALLBACK
// ======================================================

async function searchGaiaKnowledge(prompt) {

  // --------------------------------------------------
  // 1. Gemini 3.6 Flash
  // --------------------------------------------------

  try {

    const result =
      await callGeminiWithGaiaKnowledge(
        "gemini-3.6-flash",
        prompt
      );

    console.log(
      "GEMINI 3.6 + GAIA SEARCH SUCCESS"
    );

    return result;

  } catch (error1) {

    console.error(
      "GEMINI 3.6 FIRST ATTEMPT FAILED"
    );

    console.error(
      "Message:",
      error1.message
    );

  }


  // --------------------------------------------------
  // Retry after 2 seconds
  // --------------------------------------------------

  console.log(
    "WAITING 2 SECONDS BEFORE RETRY..."
  );

  await sleep(2000);


  try {

    const result =
      await callGeminiWithGaiaKnowledge(
        "gemini-3.6-flash",
        prompt
      );

    console.log(
      "GEMINI 3.6 RETRY SUCCESS"
    );

    return result;

  } catch (error2) {

    console.error(
      "GEMINI 3.6 RETRY FAILED"
    );

    console.error(
      "Message:",
      error2.message
    );

  }


  // --------------------------------------------------
  // Fallback model
  // --------------------------------------------------

  console.log(
    "SWITCHING TO GEMINI 3.5 FLASH-LITE..."
  );


  try {

    const result =
      await callGeminiWithGaiaKnowledge(
        "gemini-3.5-flash-lite",
        prompt
      );

    console.log(
      "GEMINI FALLBACK + GAIA SEARCH SUCCESS"
    );

    return result;

  } catch (error3) {

    console.error(
      "================================="
    );

    console.error(
      "ALL GEMINI MODELS FAILED"
    );

    console.error(
      "Name:",
      error3.name
    );

    console.error(
      "Message:",
      error3.message
    );

    console.error(
      "================================="
    );

    throw error3;

  }

}


// ======================================================
// CREATE GAIA PROMPT
// ======================================================

function createGaiaPrompt(
  userMessage,
  conversationText
) {

  return `
あなたは「Gaia AI Support」です。

株式会社ガイア国際センターが管理する
LINE AIサポートです。


==================================================
【最重要ルール】
==================================================

回答する前に、必ず
「Gaia Knowledge Base」
の情報を確認してください。

会社独自の情報については、
一般知識や推測ではなく、
Gaia Knowledge Baseの情報を最優先してください。


==================================================
【会社独自情報の例】
==================================================

以下は会社独自情報として扱ってください。

・給与締め日
・給与支払日
・給与計算
・給与明細
・賞与
・勤務時間
・シフト
・休日
・寮
・家賃
・会社ルール
・会社の手続き
・担当者
・連絡方法
・会社ごとの制度
・Gaia独自の案内


これらの質問について、
Gaia Knowledge Baseに該当する情報がない場合は、
一般的な情報を使って推測しないでください。


==================================================
【会社名について】
==================================================

会社名が一致しない場合、
別の会社の情報を流用してはいけません。

例えば、

Knowledge Base：
「株式会社ガイア国際センター」

ユーザー：
「会社A」

の場合、

会社Aの情報として
ガイア国際センターの情報を回答してはいけません。

必要であれば会社名を確認してください。


==================================================
【回答ルール】
==================================================

1.
Gaia Knowledge Baseに明確な情報がある場合、
その情報を使って回答してください。

2.
Gaia Knowledge Baseに情報がない場合、
「Gaiaの登録情報では確認できませんでした」
と伝えてください。

3.
情報が不足している場合は、
ユーザーに追加情報を質問してください。

4.
分からない情報を作らないでください。

5.
会社独自情報を一般的な知識で補完しないでください。

6.
日本語で質問された場合は日本語で回答してください。

7.
ベトナム語で質問された場合は
ベトナム語で回答してください。

8.
その他の言語の場合は、
可能な限りユーザーの言語で回答してください。

9.
回答は丁寧で分かりやすくしてください。

10.
LINEで読みやすいように、
必要以上に長い回答は避けてください。

11.
法律、税金、在留資格、
社会保険など重要な内容について、
確実でない情報を断定しないでください。


==================================================
【これまでの会話】
==================================================

${conversationText}


==================================================
【ユーザーの最新の質問】
==================================================

${userMessage}


Gaia Knowledge Baseにある情報を確認し、
上記ルールに従って回答してください。
`;

}


// ======================================================
// LINE WEBHOOK
// ======================================================

app.post(

  "/webhook",


  // --------------------------------------------------
  // LOG REQUEST
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
  // LINE SIGNATURE CHECK
  // --------------------------------------------------

  middleware(lineConfig),


  // --------------------------------------------------
  // MAIN WEBHOOK
  // --------------------------------------------------

  async (req, res) => {

    console.log(
      "================================="
    );

    console.log(
      "LINE WEBHOOK PASSED SIGNATURE CHECK"
    );

    console.log(
      "Events:",
      req.body.events?.length || 0
    );

    console.log(
      "================================="
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

              console.log(
                "POSTBACK RECEIVED"
              );

              console.log(
                "POSTBACK DATA:",
                event.postback.data
              );


              const data =
                event.postback.data;

              const userId =
                event.source.userId;


              // ==============================================
              // AI START
              // ==============================================

              if (
                data === "action=ai_start"
              ) {

                console.log(
                  "AI SESSION START:",
                  userId
                );


                aiSessions.set(
                  userId,
                  true
                );


                conversations.set(
                  userId,
                  []
                );


                await lineClient.replyMessage(

                  event.replyToken,

                  {

                    type: "text",

                    text:
                      "🤖 Gaia AIサポートです。\n\n" +

                      "まずGaiaに登録されている情報を確認して回答します。\n\n" +

                      "給与、VISA、年金、特定技能、JLPT、マイナンバー、仕事、日本での生活などについて質問できます。\n\n" +

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
            // TEXT MESSAGE
            // ==================================================

            if (
              event.type !== "message" ||
              event.message.type !== "text"
            ) {

              console.log(
                "NON-TEXT EVENT - SKIP"
              );

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

              console.log(
                "AI SESSION END:",
                userId
              );


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
            // CREATE CONVERSATION
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


            // ==================================================
            // ADD USER MESSAGE
            // ==================================================

            history.push({

              role: "user",

              text: userMessage

            });


            // ==================================================
            // LIMIT HISTORY
            // ==================================================

            if (
              history.length > 12
            ) {

              history.splice(
                0,
                history.length - 12
              );

            }


            // ==================================================
            // CONVERSATION TEXT
            // ==================================================

            const conversationText =
              history

                .map(
                  (item) => {

                    if (
                      item.role ===
                      "assistant"
                    ) {

                      return (
                        `AI: ${item.text}`
                      );

                    }

                    return (
                      `User: ${item.text}`
                    );

                  }
                )

                .join("\n\n");


            // ==================================================
            // CREATE PROMPT
            // ==================================================

            const prompt =
              createGaiaPrompt(
                userMessage,
                conversationText
              );


            // ==================================================
            // SEARCH GAIA KNOWLEDGE BASE
            // ==================================================

            console.log(
              "SEARCHING GAIA KNOWLEDGE BASE..."
            );


            let aiReply;


            try {

              const gaiaResult =
                await searchGaiaKnowledge(
                  prompt
                );


              // ================================================
              // INFORMATION FOUND IN GAIA
              // ================================================

              if (
                gaiaResult.grounded
              ) {

                console.log(
                  "GAIA INFORMATION FOUND"
                );


                aiReply =
                  "📘 Gaiaの登録情報に基づいて回答します。\n\n" +
                  gaiaResult.text;

              }


              // ================================================
              // NO INFORMATION IN GAIA
              // ================================================

              else {

                console.log(
                  "NO RELEVANT GAIA INFORMATION FOUND"
                );


                aiReply =
                  "🔎 Gaiaの登録情報では、この質問に関する情報を確認できませんでした。\n\n" +

                  "会社独自の情報についてのご質問の場合は、会社名や詳しい内容を教えてください。\n\n" +

                  "※現在はGaia Knowledge Baseを優先して回答しています。";

              }

            } catch (
              geminiError
            ) {

              console.error(
                "================================="
              );

              console.error(
                "GAIA KNOWLEDGE SEARCH ERROR"
              );

              console.error(
                "Name:",
                geminiError.name
              );

              console.error(
                "Message:",
                geminiError.message
              );

              console.error(
                "================================="
              );


              aiReply =
                "申し訳ありません。\n" +

                "現在Gaia AIサポートを利用できません。\n\n" +

                "少し時間をおいてから、もう一度お試しください。";

            }


            // ==================================================
            // EMPTY RESPONSE
            // ==================================================

            if (
              !aiReply
            ) {

              aiReply =
                "申し訳ありません。\n" +

                "回答を取得できませんでした。\n\n" +

                "もう一度お試しください。";

            }


            // ==================================================
            // LINE LENGTH SAFETY
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
            // SAVE AI RESPONSE
            // ==================================================

            history.push({

              role: "assistant",

              text: aiReply

            });


            // ==================================================
            // SEND TO LINE
            // ==================================================

            console.log(
              "SENDING AI RESPONSE TO LINE..."
            );


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


            } catch (
              lineError
            ) {

              console.error(
                "================================="
              );

              console.error(
                "LINE REPLY ERROR"
              );

              console.error(
                "Name:",
                lineError.name
              );

              console.error(
                "Message:",
                lineError.message
              );

              console.error(
                "================================="
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
        "================================="
      );

      console.error(
        "WEBHOOK PROCESSING ERROR"
      );

      console.error(
        "Error name:",
        error.name
      );

      console.error(
        "Error message:",
        error.message
      );

      console.error(
        "Error stack:",
        error.stack
      );

      console.error(
        "================================="
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
      "Error name:",
      err.name
    );

    console.error(
      "Error message:",
      err.message
    );

    console.error(
      "Error stack:",
      err.stack
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
// SERVER TEST
// ======================================================

app.get(

  "/",

  (
    req,
    res
  ) => {

    res.send(
      "Gaia LINE AI is running with Gaia Knowledge Base."
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
      "Primary AI: Gemini 3.6 Flash"
    );

    console.log(
      "Fallback AI: Gemini 3.5 Flash-Lite"
    );

    console.log(
      "Gaia Knowledge Base:"
    );

    console.log(
      GAIA_FILE_SEARCH_STORE
    );

  }

);
