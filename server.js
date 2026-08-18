const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();

// ========================================
// LINE CONFIG
// ========================================

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);

// ========================================
// GEMINI CONFIG
// ========================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// ========================================
// AI SESSION
// ========================================

// User nào đã bấm AIサポート
const aiSessions = new Map();

// Lưu lịch sử hội thoại
const conversations = new Map();


// ========================================
// WEBHOOK REQUEST LOG
// ========================================

app.post(
  "/webhook",

  // Log trước khi LINE middleware xử lý
  (req, res, next) => {

    console.log("=================================");
    console.log("LINE WEBHOOK REQUEST RECEIVED");
    console.log("Method:", req.method);
    console.log("URL:", req.url);
    console.log("User-Agent:", req.headers["user-agent"]);
    console.log("Has LINE Signature:",
      !!req.headers["x-line-signature"]
    );
    console.log("=================================");

    next();
  },

  // LINE signature verification
  middleware(lineConfig),

  // ======================================
  // MAIN WEBHOOK
  // ======================================

  async (req, res) => {

    console.log("=================================");
    console.log("LINE WEBHOOK PASSED SIGNATURE CHECK");
    console.log("Events:", req.body.events?.length || 0);
    console.log("=================================");

    try {

      await Promise.all(
        req.body.events.map(async (event) => {

          console.log("---------------------------------");
          console.log("EVENT TYPE:", event.type);

          // ====================================
          // POSTBACK
          // ====================================

          if (event.type === "postback") {

            console.log("POSTBACK RECEIVED");
            console.log("POSTBACK DATA:", event.postback.data);

            const data = event.postback.data;
            const userId = event.source.userId;

            // ==================================
            // AI START
            // ==================================

            if (data === "action=ai_start") {

              console.log("AI SESSION START:", userId);

              // Bật AI
              aiSessions.set(userId, true);

              // Xóa lịch sử cũ
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

              console.log("AI START MESSAGE SENT");

              return;
            }

            return;
          }


          // ====================================
          // MESSAGE
          // ====================================

          if (
            event.type !== "message" ||
            event.message.type !== "text"
          ) {

            console.log("NON-TEXT EVENT - SKIP");

            return;
          }


          const userId = event.source.userId;
          const userMessage = event.message.text.trim();

          console.log("USER ID:", userId);
          console.log("USER MESSAGE:", userMessage);


          // ====================================
          // AI終了
          // ====================================

          if (userMessage === "AI終了") {

            console.log("AI SESSION END:", userId);

            aiSessions.set(userId, false);
            conversations.delete(userId);

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


          // ====================================
          // AI NOT ACTIVE
          // ====================================

          if (!aiSessions.get(userId)) {

            console.log(
              "AI IS NOT ACTIVE - MESSAGE IGNORED"
            );

            return;
          }


          // ====================================
          // CREATE CONVERSATION
          // ====================================

          if (!conversations.has(userId)) {

            conversations.set(userId, []);

          }

          const history = conversations.get(userId);


          // ====================================
          // ADD USER MESSAGE
          // ====================================

          history.push({
            role: "user",
            text: userMessage
          });


          // ====================================
          // CREATE CONVERSATION TEXT
          // ====================================

          const conversationText = history
            .map((item) => {
              return `${item.role}: ${item.text}`;
            })
            .join("\n");


          // ====================================
          // GEMINI PROMPT
          // ====================================

          const prompt = `
あなたは「Gaia AI Support」です。

日本に住んでいる外国人をサポートするAIアシスタントです。

以下のルールを守ってください。

1. 基本的に日本語で回答してください。
2. 丁寧で分かりやすい日本語を使用してください。
3. VISA、在留資格、年金、給与、年末調整、マイナンバー、海外送金、特定技能、JLPT、仕事、日本生活などについて分かりやすく説明してください。
4. 法律・税金・在留資格など重要な内容については、断定しすぎず、必要に応じて専門機関への確認を案内してください。
5. 質問が曖昧な場合は、必要な情報を質問してください。
6. LINEで読みやすいように、回答を長くしすぎないでください。
7. 絵文字は必要な場合だけ使用してください。
8. ユーザーが日本語以外で質問した場合、その言語に合わせて回答してください。
9. 分からないことを勝手に作らないでください。

これまでの会話：

${conversationText}

ユーザーからの最新の質問：

${userMessage}
`;


          // ====================================
          // CALL GEMINI
          // ====================================

          console.log("CALLING GEMINI...");

          let aiReply;

          try {

            const result = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: prompt
            });

            aiReply = result.text;

            console.log("GEMINI RESPONSE RECEIVED");

          } catch (geminiError) {

            console.error("=================================");
            console.error("GEMINI ERROR");
            console.error("Name:", geminiError.name);
            console.error("Message:", geminiError.message);
            console.error("=================================");

            aiReply =
              "申し訳ありません。\n" +
              "現在AIサポートを利用できません。\n\n" +
              "しばらくしてからもう一度お試しください。";
          }


          // ====================================
          // CHECK AI RESPONSE
          // ====================================

          if (!aiReply) {

            aiReply =
              "申し訳ありません。\n" +
              "回答を取得できませんでした。";

          }


          // ====================================
          // SAVE AI RESPONSE
          // ====================================

          history.push({
            role: "assistant",
            text: aiReply
          });


          // ====================================
          // SEND TO LINE
          // ====================================

          console.log("SENDING AI RESPONSE TO LINE...");

          try {

            await lineClient.replyMessage(
              event.replyToken,
              {
                type: "text",
                text: aiReply
              }
            );

            console.log("AI RESPONSE SENT SUCCESSFULLY");

          } catch (lineError) {

            console.error("=================================");
            console.error("LINE REPLY ERROR");
            console.error("Name:", lineError.name);
            console.error("Message:", lineError.message);
            console.error("=================================");

          }

        })
      );


      // ====================================
      // WEBHOOK SUCCESS
      // ====================================

      console.log("WEBHOOK PROCESSING COMPLETE");

      res.status(200).end();


    } catch (error) {

      console.error("=================================");
      console.error("WEBHOOK PROCESSING ERROR");
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
      console.error("=================================");

      res.status(500).end();
    }
  }
);


// ========================================
// ERROR HANDLER
// ========================================

app.use((err, req, res, next) => {

  console.error("=================================");
  console.error("WEBHOOK ERROR");
  console.error("Error name:", err.name);
  console.error("Error message:", err.message);
  console.error("Error stack:", err.stack);
  console.error("=================================");

  if (!res.headersSent) {
    res.status(500).send("Webhook error");
  }

});


// ========================================
// SERVER TEST
// ========================================

app.get("/", (req, res) => {

  res.send("Gaia LINE AI is running.");

});


// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `Gaia LINE AI server running on port ${PORT}`
  );

});
