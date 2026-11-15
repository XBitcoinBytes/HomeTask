/**
 * Safe boundary for explicit v1 custom-room records.
 *
 * Room records live in the dedicated hometask-rooms-v1 key, never among task
 * records. This keeps historic task arrays compatible while allowing an empty
 * user-created room to survive independently of task assignments.
 */
import { isPlainObject } from './custom-record.js';

const ROOM_SCHEMA_VERSION = 1;
const ROOM_NAME_MAX_LENGTH = 50;
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function normalizeRoomName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function canonicalRoomName(value) {
  return normalizeRoomName(value).toLowerCase();
}

function sanitizeCustomRoomRecord(record, { seedRooms = new Set() } = {}) {
  if (!isPlainObject(record) || record._customRoom !== true) return null;
  if (typeof record.id !== 'string' || !ROOM_ID_RE.test(record.id)) return null;
  const name = normalizeRoomName(record.name);
  if (!name || name.length > ROOM_NAME_MAX_LENGTH) return null;
  if (seedRooms.has(canonicalRoomName(name))) return null;
  return { id: record.id, name, _customRoom: true };
}

function sanitizeCustomRoomState(value, { seedRooms = new Set() } = {}) {
  if (!isPlainObject(value) || value.schemaVersion !== ROOM_SCHEMA_VERSION || !Array.isArray(value.rooms)) {
    return [];
  }
  const seenIds = new Set();
  const seenNames = new Set();
  const rooms = [];
  for (const record of value.rooms) {
    const room = sanitizeCustomRoomRecord(record, { seedRooms });
    const nameKey = room && canonicalRoomName(room.name);
    if (!room || seenIds.has(room.id) || seenNames.has(nameKey)) continue;
    seenIds.add(room.id);
    seenNames.add(nameKey);
    rooms.push(room);
  }
  return rooms;
}

function serializeCustomRoomState(records, { seedRooms = new Set() } = {}) {
  const rooms = sanitizeCustomRoomState({
    schemaVersion: ROOM_SCHEMA_VERSION,
    rooms: Array.isArray(records) ? records : [],
  }, { seedRooms });
  return JSON.stringify({ schemaVersion: ROOM_SCHEMA_VERSION, rooms });
}

export {
  ROOM_NAME_MAX_LENGTH,
  canonicalRoomName,
  normalizeRoomName,
  sanitizeCustomRoomRecord,
  sanitizeCustomRoomState,
  serializeCustomRoomState,
};