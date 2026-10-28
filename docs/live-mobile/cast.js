// Sending the picture to another screen with WebRTC, without a server: the two pages swap two short text codes by hand.
export const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pipe(u8, T) { const s = new Blob([u8]).stream().pipeThrough(new T('deflate')); return new Uint8Array(await new Response(s).arrayBuffer()); }

// description -> short text. "z" = compressed, "p" = plain
export async function encodeCode(desc) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
  if (typeof CompressionStream === 'function') return 'z' + b64(await pipe(raw, CompressionStream));
  return 'p' + b64(raw);
}
export async function decodeCode(text) {
  const t = String(text || '').trim().replace(/\s+/g, '');
  if (!t) throw new Error('The code is empty.');
  try {
    const body = unb64(t.slice(1)); const raw = t[0] === 'z' ? await pipe(body, DecompressionStream) : body;
    const d = JSON.parse(new TextDecoder().decode(raw)); if (!d.sdp || !d.type) throw 0; return d;
  } catch { throw new Error('That code does not look right. Copy all of it, with nothing added.'); }
}
// wait until the browser has found its network addresses (or give up after a while: what it has is usually enough)
export function gathered(pc, ms = 4000) {
  return new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(done, ms); function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', ch); res(); } function ch() { if (pc.iceGatheringState === 'complete') done(); } pc.addEventListener('icegatheringstatechange', ch); });
}
export async function makeOffer(stream, iceServers = ICE) {
  const pc = new RTCPeerConnection({ iceServers });
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  await pc.setLocalDescription(await pc.createOffer()); await gathered(pc);
  return { pc, code: await encodeCode(pc.localDescription) };
}
export async function makeAnswer(offerCode, onTrack, iceServers = ICE) {
  const offer = await decodeCode(offerCode), pc = new RTCPeerConnection({ iceServers });
  pc.ontrack = e => onTrack(e.streams[0] || new MediaStream([e.track]));
  await pc.setRemoteDescription(offer); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc);
  return { pc, code: await encodeCode(pc.localDescription) };
}
export async function accept(pc, answerCode) { await pc.setRemoteDescription(await decodeCode(answerCode)); }
