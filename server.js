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
// AI SESSION
// ======================================================

// User đã bật AI
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
// HELPER: CALL GEMINI
// ======================================================

async function callGemini(model, prompt) {

  console.log(`CALLING MODEL: ${model}`);

  const result = await ai.models.generateContent({
    model: model,
    contents: prompt
  });

  if (!result.text) {
    throw new Error("Gemini returned an empty response.");
  }

  return result.text;
}


// ======================================================
// GEMINI WITH RETRY + FALLBACK
// ======================================================

async function generateAIResponse(prompt) {

  // --------------------------------------------------
  // 1. Gemini 3.6 Flash - First attempt
  // --------------------------------------------------

  try {

    const response = await callGemini(
      "gemini-3.6-flash",
      prompt
    );

    console.log("GEMINI 3.6 SUCCESS");

    return response;

  } catch (error1) {

    console.error("GEMINI 3.6 FIRST ATTEMPT FAILED");
    console.error("Message:", error1.message);

  }


  // --------------------------------------------------
  // Wait 2 seconds
  // --------------------------------------------------

  console.log("WAITING 2 SECONDS BEFORE RETRY...");

  await sleep(2000);


  // --------------------------------------------------
  // 2. Gemini 3.6 Flash - Retry
  // --------------------------------------------------

  try {

    const response = await callGemini(
      "gemini-3.6-flash",
      prompt
    );

    console.log("GEMINI 3.6 RETRY SUCCESS");

    return response;

  } catch (error2) {

    console.error("GEMINI 3.6 RETRY FAILED");
    console.error("Message:", error2.message);

  }


  // --------------------------------------------------
  // 3. Fallback → Gemini 3.5 Flash-Lite
  // --------------------------------------------------

  console.log(
    "SWITCHING TO GEMINI 3.5 FLASH-LITE..."
  );

  try {

    const response = await callGemini(
      "gemini-3.5-flash-lite",
      prompt
    );

    console.log(
      "GEMINI 3.5 FLASH-LITE SUCCESS"
    );

    return response;

  } catch (error3) {

    console.error("=================================");
    console.error("ALL GEMINI MODELS FAILED");
    console.error("Name:", error3.name);
    console.error("Message:", error3.message);
    console.error("=================================");

    throw error3;
  }
}


// ======================================================
// LINE WEBHOOK
// ======================================================

app.post(

  "/webhook",

  // --------------------------------------------------
  // Request log
  // --------------------------------------------------

  (req, res, next) => {

    console.log("=================================");
    console.log("LINE WEBHOOK REQUEST RECEIVED");
    console.log("Method:", req.method);
    console.log("URL:", req.url);
    console.log(
      "User-Agent:",
      req.headers["user-agent"]
    );

    console.log(
      "Has LINE Signature:",
      !!req.headers["x-line-signature"]
    );

    console.log("=================================");

    next();
  },


  // --------------------------------------------------
  // LINE signature verification
  // --------------------------------------------------

  middleware(lineConfig),


  // --------------------------------------------------
  // Main webhook
  // --------------------------------------------------

  async (req, res) => {

    console.log("=================================");
    console.log(
      "LINE WEBHOOK PASSED SIGNATURE CHECK"
    );

    console.log(
      "Events:",
      req.body.events?.length || 0
    );

    console.log("=================================");


    try {

      await Promise.all(

        req.body.events.map(async (event) => {

          console.log("---------------------------------");
          console.log("EVENT TYPE:", event.type);


          // ==================================================
          // POSTBACK
          // ==================================================

          if (event.type === "postback") {

            console.log("POSTBACK RECEIVED");

            console.log(
              "POSTBACK DATA:",
              event.postback.data
            );


            const data = event.postback.data;

            const userId =
              event.source.userId;


            // ==============================================
            // AI START
            // ==============================================

            if (data === "action=ai_start") {

              console.log(
                "AI SESSION START:",
                userId
              );


              // Bật AI
              aiSessions.set(userId, true);


              // Reset lịch sử
              conversations.set(userId, []);


              await lineClient.replyMessage(

                event.replyToken,

                {
                  type: "text",

                  text:
                    "🤖 Gaia AIサポートです。\n\n" +

                    "VISA、給与、年金、特定技能、JLPT、" +
                    "マイナンバー、仕事や日本での生活について質問できます。\n\n" +

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

          if (userMessage === "AI終了") {

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

          if (!aiSessions.get(userId)) {

            console.log(
              "AI IS NOT ACTIVE - MESSAGE IGNORED"
            );

            return;
          }


          // ==================================================
          // CONVERSATION
          // ==================================================

          if (!conversations.has(userId)) {

            conversations.set(
              userId,
              []
            );

          }


          const history =
            conversations.get(userId);


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

          // Chỉ giữ 12 message gần nhất
          // để tránh prompt ngày càng dài

          if (history.length > 12) {

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

              .map((item) => {

                if (
                  item.role === "assistant"
                ) {

                  return (
                    `AI: ${item.text}`
                  );

                }


                return (
                  `User: ${item.text}`
                );

              })

              .join("\n\n");


          // ==================================================
          // PROMPT
          // ==================================================

          const prompt = `
あなたは「Gaia AI Support」です。

日本で生活・就労している外国人をサポートするAIアシスタントです。

【回答ルール】

1. 基本的に日本語で回答してください。

2. ユーザーがベトナム語、英語など日本語以外で質問した場合は、原則としてその言語で回答してください。

3. 丁寧で分かりやすい言葉を使用してください。

4. 以下のような内容についてサポートしてください。

・VISA、在留資格
・特定技能
・給与、給与明細
・賞与
・年金
・年末調整
・マイナンバー
・海外送金
・JLPT、日本語学習
・仕事
・日本での生活

5. 法律、税金、在留資格、社会保険など重要な内容について、確実でない情報を断定しないでください。

6. 制度変更など最新情報の確認が必要な場合は、入管、年金事務所、市区町村、税務署、勤務先などの公的・適切な窓口への確認も案内してください。

7. 質問が曖昧で、正確な回答に追加情報が必要な場合は、ユーザーに必要な情報を質問してください。

8. LINEで読みやすい文章にしてください。

9. 必要以上に長い回答は避けてください。

10. 分からない情報を作らないでください。

11. ユーザーの質問に直接答えてください。


【これまでの会話】

${conversationText}


【最新の質問】

${userMessage}
`;


          // ==================================================
          // CALL GEMINI
          // ==================================================

          console.log(
            "STARTING GEMINI REQUEST..."
          );


          let aiReply;


          try {

            aiReply =
              await generateAIResponse(
                prompt
              );


            console.log(
              "AI RESPONSE RECEIVED"
            );


          } catch (geminiError) {

            console.error(
              "================================="
            );

            console.error(
              "GEMINI FINAL ERROR"
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

              "現在AIサポートが混み合っています。\n\n" +

              "少し時間をおいてから、もう一度お試しください。";

          }


          // ==================================================
          // EMPTY RESPONSE CHECK
          // ==================================================

          if (!aiReply) {

            aiReply =
              "申し訳ありません。\n" +
              "回答を取得できませんでした。\n\n" +
              "もう一度お試しください。";

          }


          // ==================================================
          // LINE MESSAGE LENGTH SAFETY
          // ==================================================

          // Tránh gửi response quá dài
          if (aiReply.length > 4500) {

            aiReply =
              aiReply.substring(0, 4500) +

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
          // SEND RESPONSE TO LINE
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


          } catch (lineError) {

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

        })

      );


      // ==================================================
      // WEBHOOK SUCCESS
      // ==================================================

      console.log(
        "WEBHOOK PROCESSING COMPLETE"
      );


      res.status(200).end();


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


      res.status(500).end();

    }

  }

);


// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (err, req, res, next) => {

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


    if (!res.headersSent) {

      res
        .status(500)
        .send("Webhook error");

    }

  }
);


// ======================================================
// SERVER TEST
// ======================================================

app.get(
  "/",
  (req, res) => {

    res.send(
      "Gaia LINE AI is running."
    );

  }
);


// ======================================================
// START SERVER
// ======================================================

const PORT =
  process.env.PORT || 3000;


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

  }
);
