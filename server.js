const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const OpenAI = require("openai");

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// LINE Webhook
app.post(
  "/webhook",
  middleware(lineConfig),
  async (req, res) => {
    try {
      await Promise.all(
        req.body.events.map(async (event) => {
          // Chỉ xử lý tin nhắn dạng text
          if (
            event.type !== "message" ||
            event.message.type !== "text"
          ) {
            return;
          }

          const userMessage = event.message.text;

          // Gửi câu hỏi đến OpenAI
          const response = await openai.responses.create({
            model: "gpt-5-mini",
            instructions:
              "Bạn là Gaia AI Support, trợ lý hỗ trợ người dùng Gaia trên LINE. " +
              "Trả lời bằng tiếng Nhật lịch sự, dễ hiểu và ngắn gọn. " +
              "Nếu chưa đủ thông tin để trả lời chính xác, hãy hỏi lại người dùng.",
            input: userMessage
          });

          const aiReply =
            response.output_text ||
            "申し訳ありません。現在回答を取得できません。";

          // Trả lời người dùng trên LINE
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: aiReply
          });
        })
      );

      res.status(200).end();
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).end();
    }
  }
);

// Trang kiểm tra server
app.get("/", (req, res) => {
  res.send("Gaia LINE AI is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Gaia LINE AI server running on port ${PORT}`);
});
