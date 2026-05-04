const express = require('express');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

app.get('/', (req, res) => {
  const {
    'hub.mode': mode,
    'hub.challenge': challenge,
    'hub.verify_token': token,
  } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }

  return res.status(403).end();
});

app.post('/', async (req, res) => {
  console.log('Webhook received');
  console.log(JSON.stringify(req.body, null, 2));

  // Responder rápido a Meta
  res.status(200).end();

  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return;

    const from = message.from; // número del usuario que te escribió

    await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: {
            body: 'Hola 👋 Soy tu bot de Thermomix. Recibí tu mensaje correctamente.',
          },
        }),
      }
    );

    console.log('Reply sent');
  } catch (error) {
    console.error('Error sending reply:', error);
  }
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
