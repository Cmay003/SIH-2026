// =====================================================================
// SANJEEVNI node - reading_uid session numbers (hardware-independent, so
// it is unit-tested on a PC: tools/firmware_host_test).
//
// reading_uid = "<session>-<seq>" and the backend treats a uid it has
// already stored for this node_id as a resend and DROPS it. The session
// used to be an NVS counter starting at 1: a replacement board flashed
// with the same NODE_ID, or a board whose NVS was erased, counted 1, 2, 3
// again and the backend silently threw its new readings away as
// duplicates of the old board's - for weeks after a long session.
//
// Now the first boot (no counter in NVS) starts at a random 32-bit value
// and every later power-on adds 1. The same board therefore never repeats
// a session, and a new board / erased NVS lands somewhere else in 4.3
// billion values: a clash needs the two boards' runs of sessions to
// overlap - (old + new power-ons) / 4.3 billion, e.g. about 1 in 7 million
// for 300 power-ons each.
// =====================================================================
#pragma once
#include <stdint.h>

// murmur3's 32-bit finaliser: every input bit affects every output bit
inline uint32_t sjMix32(uint32_t h) {
  h ^= h >> 16;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  h *= 0xc2b2ae35u;
  h ^= h >> 16;
  return h;
}

// Start value for a board with no session in NVS. `efuseMac` is unique per
// chip, so two boards differ even if their random sources were not; the
// random words (esp_random() and the transport's noise source) make an
// erased NVS on the SAME board start somewhere new. Never 0.
inline uint32_t sjFreshSession(uint64_t efuseMac, uint32_t random1, uint32_t random2) {
  uint32_t h = sjMix32((uint32_t)efuseMac ^ sjMix32((uint32_t)(efuseMac >> 32)));
  h = sjMix32(h ^ random1);
  h = sjMix32(h ^ random2);
  return h ? h : 1;
}

// The session for this power-on: the stored one + 1, or the fresh start
// when NVS has none. 0 is skipped (all-zero state looks "unset").
inline uint32_t sjNextSession(bool haveStored, uint32_t stored, uint32_t fresh) {
  uint32_t s = haveStored ? stored + 1 : fresh;
  return s ? s : 1;
}
