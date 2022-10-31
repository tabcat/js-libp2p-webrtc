import {Stream, StreamStat, Direction} from '@libp2p/interface-connection';
import {Source} from 'it-stream-types';
import {Sink} from 'it-stream-types';
import {pushable} from 'it-pushable';
import * as lp from 'it-length-prefixed';
import { pipe } from 'it-pipe';
import defer, {DeferredPromise} from 'p-defer';
import merge from 'it-merge';
import {Uint8ArrayList} from 'uint8arraylist';
import {logger} from '@libp2p/logger';
import * as pb from '../proto_ts/message.js';
import {concat} from 'uint8arrays/concat';

const log = logger('libp2p:webrtc:stream');

export function defaultStat(dir: Direction): StreamStat {
  return {
    direction: dir,
    timeline: {
      open: 0,
      close: undefined,
    },
  };
}

type StreamInitOpts = {
  channel: RTCDataChannel;
  metadata?: Record<string, any>;
  stat: StreamStat;
  closeCb?: (stream: WebRTCStream) => void;
};

export class WebRTCStream implements Stream {
  /**
   * Unique identifier for a stream
   */
  id: string;

  /**
   * Stats about this stream
   */
  stat: StreamStat;

  /**
   * User defined stream metadata
   */
  metadata: Record<string, any>;
  private readonly channel: RTCDataChannel;

  private readonly _src: Source<Uint8ArrayList>;
  _innersrc = pushable();
  sink: Sink<Uint8ArrayList | Uint8Array, Promise<void>>;

  // promises
  opened: DeferredPromise<void> = defer();
  closeWritePromise: DeferredPromise<void> = defer();
  writeClosed: boolean = false;
  readClosed: boolean = false;
  closed: boolean = false;
  closeCb?: (stream: WebRTCStream) => void | undefined

  // read state
  messageState: MessageState = new MessageState();

  // testing

  constructor(opts: StreamInitOpts) {
    this.channel = opts.channel;
    this.id = this.channel.label;

    this.stat = opts.stat;
    switch (this.channel.readyState) {
      case 'open':
        this.opened.resolve();
        break;
      case 'closed':
      case 'closing':
        this.closed = true;
        if (!this.stat.timeline.close) {
          this.stat.timeline.close = new Date().getTime();
        }
        this.opened.resolve();
        break;
    }

    this.metadata = opts.metadata ?? {};

    // closable sink
    this.sink = this._sinkFn;

    // handle RTCDataChannel events
    this.channel.onopen = (_evt) => {
      this.stat.timeline.open = new Date().getTime();
      this.opened.resolve();
    };

    this.channel.onclose = (_evt) => {
      this.close();
    };

    this.channel.onerror = (evt) => {
      let err = (evt as RTCErrorEvent).error;
      this.abort(err);
    };

    const self = this;
    // reader pipe
    this.channel.onmessage = async ({data}) => {
      const res = new Uint8Array(data as ArrayBuffer);
      if (res.length == 0) {
        return
      }
      this._innersrc.push(res)
    };

    this._src = pipe(
      this._innersrc,
      lp.decode(),
      (source) => (async function * () {
        for await (const buf of source) {
          const { data } = self.processIncomingProtobuf(buf.subarray());
          if (data) {
            yield new Uint8ArrayList(data);
          }
        }
      })(),
    )

  }

  // If user attempts to set a new source
  // this should be a nop
  set source(_src: Source<Uint8ArrayList>) {
  }

  get source(): Source<Uint8ArrayList> {
    return this._src
  }

  private async _sinkFn(src: Source<Uint8ArrayList | Uint8Array>): Promise<void> {
    await this.opened.promise;
    if (closed || this.writeClosed) {
      return;
    }

    const self = this;
    const closeWriteIterable = {
      async *[Symbol.asyncIterator]() {
        await self.closeWritePromise.promise;
        yield new Uint8Array(0);
      },
    };

    for await (const buf of merge(closeWriteIterable, src)) {
      if (closed || this.writeClosed) {
        break;
      }
      const res = buf.subarray();
      const msgbuf = pb.Message.toBinary({message: buf.subarray()});
      const sendbuf = lp.encode.single(msgbuf)
      log.trace(`[stream:${this.id}][${this.stat.direction}] sending message: length: ${res.length} ${res}, encoded through pb as ${msgbuf}`);
      this.channel.send(sendbuf.subarray())
    }
  }

  processIncomingProtobuf(buffer: Uint8Array): { data: Uint8Array | undefined } {
    log.trace(`[stream:${this.id}][${this.stat.direction}] received message: length: ${buffer.length} ${buffer}`);
    const m = pb.Message.fromBinary(buffer);
    log.trace(`[stream:${this.id}][${this.stat.direction}] received pb.Message: ${Object.entries(m)}`);
    switch (m.flag) {
      case undefined:
        break; //regular message only
      case pb.Message_Flag.STOP_SENDING:
        log.trace('Remote has indicated, with "STOP_SENDING" flag, that it will discard any messages we send.');
        this.closeWrite();
        break;
      case pb.Message_Flag.FIN:
        log.trace('Remote has indicated, with "FIN" flag, that it will not send any further messages.');
        this.closeRead();
        break;
      case pb.Message_Flag.RESET:
        log.trace('Remote abruptly stopped sending, indicated with "RESET" flag.');
        this.closeRead();
    }
    if (this.readClosed || this.closed) {
      return { data: undefined };
    }
    return { data: m.message }
  }

  /**
   * Close a stream for reading and writing
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.stat.timeline.close = new Date().getTime();
    this.closed = true;
    this.readClosed = true;
    this.writeClosed = true;
    this.channel.close();
    if (this.closeCb) {
      this.closeCb(this)
    }
  }

  /**
   * Close a stream for reading only
   */
  closeRead(): void {
    this._sendFlag(pb.Message_Flag.STOP_SENDING);
    this.readClosed = true;
    (this._innersrc).end();
    if (this.readClosed && this.writeClosed) {
      this.close();
    }
  }

  /**
   * Close a stream for writing only
   */
  closeWrite(): void {
    this._sendFlag(pb.Message_Flag.FIN);
    this.writeClosed = true;
    this.closeWritePromise.resolve();
    if (this.readClosed && this.writeClosed) {
      this.close();
    }
  }

  /**
   * Call when a local error occurs, should close the stream for reading and writing
   */
  abort(err: Error): void {
    this.close();
  }

  /**
   * Close the stream for writing, and indicate to the remote side this is being done 'abruptly'
   * @see closeWrite
   */
  reset(): void {
    this.stat = defaultStat(this.stat.direction);
    this._sendFlag(pb.Message_Flag.RESET);
    this.writeClosed = true;
    this.closeWritePromise.resolve();
    if (this.readClosed && this.writeClosed) {
      this.close();
    }
  }

  private _sendFlag(flag: pb.Message_Flag): void {
    try {
      log.trace('Sending flag: %s', flag.toString());
      const msgbuf = pb.Message.toBinary({flag: flag});
      this.channel.send(lp.encode.single(msgbuf).subarray());
    } catch (e) {
      log.error(`Exception while sending flag ${flag}: ${e}`);
    }
  }
}

class MessageState {
  public buffer: Uint8Array = new Uint8Array()
  public messageSize: number = 0;

  public bytesRemaining(): number {
    return this.messageSize - this.buffer.length;
  }

  public hasMessage(): boolean {
    return this.messageSize != 0 && this.buffer.length == this.messageSize;
  }

  public write(b: Uint8Array) {
    this.buffer = concat([this.buffer, b]);
  }

  public clear() {
    this.buffer = new Uint8Array();
    this.messageSize = 0;
  }


}
