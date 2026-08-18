const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Lưu trạng thái AI của từng user
const aiSessions = new Map();

// Lưu lịch sử hội thoại của từng user
const conversations = new Map();


// ==============================
// LINE WEBHOOK
// ==============================

app.post(
  "/webhook",
  middleware(lineConfig),
  async (req, res) => {

    try {

      await Promise.all(
        req.body.events.map(async (event) => {

          // ==========================
          // 1. POSTBACK
          // ==========================

          if (event.type === "postback") {

            const data = event.postback.data;

            // Người dùng bấm AIサポート
            if (data === "action=ai_start") {

              const userId = event.source.userId;

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
                    "VISA、給与、年金、年末調整、特定技能、JLPTなどについて質問できます。\n\n" +
                    "ご質問を入力してください。\n\n" +
                    "AIを終了する場合は「AI終了」と入力してください。"
                }
              );

              return;
            }

            return;
          }


          // ==========================
          // 2. TEXT MESSAGE
          // ==========================

          if (
            event.type !== "message" ||
            event.message.type !== "text"
          ) {
            return;
          }

          const userId = event.source.userId;
          const userMessage = event.message.text.trim();


          // ==========================
          // AI終了
          // ==========================

          if (userMessage === "AI終了") {

            aiSessions.set(userId, false);
            conversations.delete(userId);

            await lineClient.replyMessage(
              event.replyToken,
              {
                type: "text",
                text:
                  "AIサポートを終了しました。\n\n" +
                  "また利用する場合は「④ AIサポート」をタップしてください。"
              }
            );

            return;
          }


          // ==========================
          // AI OFF
          // ==========================

          if (!aiSessions.get(userId)) {

            // AIが起動していない場合は何もしない
            return;
          }


          // ==========================
          // 会話履歴
          // ==========================

          if (!conversations.has(userId)) {
            conversations.set(userId, []);
          }

          const history = conversations.get(userId);

          history.push({
            role: "user",
            text: userMessage
          });


          // ==========================
          // Gemini に送信
          // ==========================

          const conversationText = history
            .map((item) => {
              return `${item.role}: ${item.text}`;
            })
            .join("\n");


          const prompt = `
あなたは「Gaia AI Support」です。

日本に住んでいる外国人をサポートするAIアシスタントです。

以下のルールを守ってください。

1. 基本的に日本語で回答してください。
2. 丁寧で分かりやすい日本語を使用してください。
3. VISA、在留資格、年金、給与、年末調整、マイナンバー、海外送金、特定技能、JLPT、仕事、生活などについて分かりやすく説明してください。
4. 法律・税金・在留資格など重要な内容については、断定しすぎず、必要に応じて専門機関への確認を案内してください。
5. 質問が曖昧な場合は、必要な情報を質問してください。
6. 長すぎる回答は避け、LINEで読みやすい形式にしてください。
7. 絵文字は必要な場合だけ使用してください。

これまでの会話：

${conversationText}

ユーザーからの最新の質問：

${userMessage}
`;


          const result = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt
          });


          const aiReply =
            result.text ||
            "申し訳ありません。回答を取得できませんでした。";


          // ==========================
          // 履歴にAI回答を保存
          // ==========================

          history.push({
            role: "assistant",
            text: aiReply
          });


          // ==========================
          // LINE に返信
          // ==========================

          await lineClient.replyMessage(
            event.replyToken,
            {
              type: "text",
              text: aiReply
            }
          );

        })
      );

      res.status(200).end();

    } catch (error) {

      console.error("Webhook error:", error);

      res.status(500).end();
    }
  }
);


// ==============================
// SERVER TEST
// ==============================

app.get("/", (req, res) => {
  res.send("Gaia LINE AI is running.");
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Gaia LINE AI server running on port ${PORT}`
  );
});
