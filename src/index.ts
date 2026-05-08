import 'dotenv/config';
import express, { Request, Response } from 'express';
import * as ms from './mediasoup.manager';

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3001;

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post('/rooms/:callId', async (req: Request, res: Response) => {
  try {
    await ms.ensureRoom(req.params.callId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/rooms/:callId/rtp-capabilities', async (req: Request, res: Response) => {
  try {
    await ms.ensureRoom(req.params.callId);
    res.json(ms.getRouterRtpCapabilities(req.params.callId));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rooms/:callId/transports', async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' }) as any;
    const result = await ms.createTransport(req.params.callId, userId);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rooms/:callId/transports/:transportId/connect', async (req: Request, res: Response) => {
  try {
    const { dtlsParameters } = req.body;
    await ms.connectTransport(req.params.callId, req.params.transportId, dtlsParameters);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rooms/:callId/transports/:transportId/produce', async (req: Request, res: Response) => {
  try {
    const { userId, kind, rtpParameters } = req.body;
    const producerId = await ms.produce(
      req.params.callId,
      req.params.transportId,
      userId,
      kind,
      rtpParameters,
    );
    res.json({ producerId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rooms/:callId/consume', async (req: Request, res: Response) => {
  try {
    const { transportId, producerId, rtpCapabilities } = req.body;
    const result = await ms.consume(
      req.params.callId,
      transportId,
      producerId,
      rtpCapabilities,
    );
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/rooms/:callId/consumers/:consumerId/resume', async (req: Request, res: Response) => {
  try {
    await ms.resumeConsumer(req.params.callId, req.params.consumerId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/rooms/:callId/producers', (req: Request, res: Response) => {
  try {
    res.json({ producers: ms.getProducers(req.params.callId) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/rooms/:callId/users/:userId', (req: Request, res: Response) => {
  try {
    const closedProducerIds = ms.closeUserResources(req.params.callId, req.params.userId);
    res.json({ closedProducerIds });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/rooms/:callId', (req: Request, res: Response) => {
  try {
    ms.closeRoom(req.params.callId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

async function bootstrap() {
  await ms.startWorker();
  app.listen(PORT, () => {
    console.log(`mediasoup-server listening on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
