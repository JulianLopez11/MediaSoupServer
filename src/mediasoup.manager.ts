import * as mediasoup from 'mediasoup';

type Worker = mediasoup.types.Worker;
type Router = mediasoup.types.Router;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;
type RtpCapabilities = mediasoup.types.RtpCapabilities;
type DtlsParameters = mediasoup.types.DtlsParameters;
type MediaKind = mediasoup.types.MediaKind;
type RtpParameters = mediasoup.types.RtpParameters;

interface ProducerInfo {
  userId: string;
  producer: Producer;
  kind: 'audio' | 'video';
}

interface TransportInfo {
  transport: WebRtcTransport;
  userId: string;
}

interface RoomData {
  router: Router;
  producers: Map<string, ProducerInfo>;
  transports: Map<string, TransportInfo>;
  consumers: Map<string, Consumer>;
}

// preferredPayloadType intentionally omitted — mediasoup assigns them internally;
// explicit values cause "duplicated codec.preferredPayloadType" when RTX codecs are added.
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
    },
  },
] as unknown as mediasoup.types.RtpCodecCapability[];

let worker: Worker;
const rooms = new Map<string, RoomData>();

export async function startWorker(): Promise<void> {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT ?? '40000'),
    rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT ?? '49999'),
  });

  worker.on('died', async () => {
    console.error('[mediasoup] worker died — restarting');
    await startWorker();
  });

  console.log('[mediasoup] worker started');
}

export async function ensureRoom(callId: string): Promise<void> {
  if (!rooms.has(callId)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(callId, {
      router,
      producers: new Map(),
      transports: new Map(),
      consumers: new Map(),
    });
    console.log(`[mediasoup] room created for call ${callId}`);
  }
}

export function getRouterRtpCapabilities(callId: string): RtpCapabilities {
  const room = rooms.get(callId);
  if (!room) throw new Error(`Room not found: ${callId}`);
  return room.router.rtpCapabilities;
}

export async function createTransport(callId: string, userId: string) {
  const room = rooms.get(callId);
  if (!room) throw new Error(`Room not found: ${callId}`);

  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP ?? '127.0.0.1';

  const transport = await room.router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 600_000,
  });

  room.transports.set(transport.id, { transport, userId });
  console.log(`[mediasoup] transport ${transport.id} for user ${userId}`);

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

export async function connectTransport(
  callId: string,
  transportId: string,
  dtlsParameters: DtlsParameters,
): Promise<void> {
  const room = rooms.get(callId);
  if (!room) throw new Error(`Room not found: ${callId}`);
  const info = room.transports.get(transportId);
  if (!info) throw new Error(`Transport ${transportId} not found`);
  await info.transport.connect({ dtlsParameters });
}

export async function produce(
  callId: string,
  transportId: string,
  userId: string,
  kind: MediaKind,
  rtpParameters: RtpParameters,
): Promise<string> {
  const room = rooms.get(callId);
  if (!room) throw new Error(`Room not found: ${callId}`);
  const info = room.transports.get(transportId);
  if (!info) throw new Error(`Transport ${transportId} not found`);

  const producer = await info.transport.produce({ kind, rtpParameters });
  room.producers.set(producer.id, { userId, producer, kind: kind as 'audio' | 'video' });

  producer.on('transportclose', () => {
    room.producers.delete(producer.id);
  });

  console.log(`[mediasoup] producer ${producer.id} (${kind}) for user ${userId}`);
  return producer.id;
}

export async function consume(
  callId: string,
  transportId: string,
  producerId: string,
  rtpCapabilities: RtpCapabilities,
) {
  const room = rooms.get(callId);
  if (!room) throw new Error(`Room not found: ${callId}`);
  const transportInfo = room.transports.get(transportId);
  if (!transportInfo) throw new Error(`Transport ${transportId} not found`);

  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error(`Cannot consume producer ${producerId}`);
  }

  const consumer = await transportInfo.transport.consume({
    producerId,
    rtpCapabilities,
    paused: true,
  });

  room.consumers.set(consumer.id, consumer);

  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

export async function resumeConsumer(callId: string, consumerId: string): Promise<void> {
  const room = rooms.get(callId);
  if (!room) return;
  const consumer = room.consumers.get(consumerId);
  if (consumer && !consumer.closed) await consumer.resume();
}

export function getProducers(
  callId: string,
): { userId: string; producerId: string; kind: string }[] {
  const room = rooms.get(callId);
  if (!room) return [];
  return Array.from(room.producers.entries()).map(([id, info]) => ({
    userId: info.userId,
    producerId: id,
    kind: info.kind,
  }));
}

export function closeUserResources(callId: string, userId: string): string[] {
  const room = rooms.get(callId);
  if (!room) return [];

  const closedIds: string[] = [];

  for (const [id, info] of room.producers.entries()) {
    if (info.userId === userId) {
      if (!info.producer.closed) info.producer.close();
      room.producers.delete(id);
      closedIds.push(id);
    }
  }

  for (const [id, info] of room.transports.entries()) {
    if (info.userId === userId) {
      if (!info.transport.closed) info.transport.close();
      room.transports.delete(id);
    }
  }

  if (closedIds.length > 0) {
    console.log(
      `[mediasoup] closed resources for user ${userId} in call ${callId}: [${closedIds.join(', ')}]`,
    );
  }
  return closedIds;
}

export function closeRoom(callId: string): void {
  const room = rooms.get(callId);
  if (room) {
    if (!room.router.closed) room.router.close();
    rooms.delete(callId);
    console.log(`[mediasoup] room closed for call ${callId}`);
  }
}
