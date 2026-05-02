/**
 * region-parse 纯函数单测。
 *
 * 同一份解析逻辑同时被 src/lib/region.ts（Node）与 src/middleware.ts（Edge）
 * 共享 —— 任何对解析规则的改动都要在这里加一组 case，确保两端永不漂移。
 */

import { describe, expect, it } from 'vitest';

import { isLegacyRegionFallback, parseRegion, type RegionEnvSource } from './region-parse';

describe('parseRegion', () => {
  it('两个 env 都未配置 → GLOBAL（dev / 测试友好默认）', () => {
    expect(parseRegion({})).toBe('GLOBAL');
  });

  it.each<[string, RegionEnvSource, 'GLOBAL' | 'CN' | 'EU']>([
    ['KITORA_REGION=GLOBAL', { KITORA_REGION: 'GLOBAL' }, 'GLOBAL'],
    ['KITORA_REGION=CN', { KITORA_REGION: 'CN' }, 'CN'],
    ['KITORA_REGION=EU', { KITORA_REGION: 'EU' }, 'EU'],
  ])('canonical %s → %s', (_label, source, expected) => {
    expect(parseRegion(source)).toBe(expected);
  });

  it.each<[string, RegionEnvSource, 'GLOBAL' | 'CN' | 'EU']>([
    ['legacy REGION=cn', { REGION: 'cn' }, 'CN'],
    ['legacy REGION=global', { REGION: 'global' }, 'GLOBAL'],
  ])('%s → %s', (_label, source, expected) => {
    expect(parseRegion(source)).toBe(expected);
  });

  it('legacy REGION=eu（v0.5 没出过这个值）→ 回落到 GLOBAL', () => {
    expect(parseRegion({ REGION: 'eu' })).toBe('GLOBAL');
  });

  it('canonical 命中时优先于 legacy', () => {
    expect(parseRegion({ KITORA_REGION: 'CN', REGION: 'global' })).toBe('CN');
  });

  it('canonical 是垃圾值 + legacy 合法 → 走 legacy（与 isLegacyRegionFallback 一致）', () => {
    expect(parseRegion({ KITORA_REGION: 'XX', REGION: 'cn' })).toBe('CN');
  });

  it('canonical 是垃圾值 + 没有 legacy → 默认 GLOBAL', () => {
    expect(parseRegion({ KITORA_REGION: 'XX' })).toBe('GLOBAL');
  });

  it('canonical 是空字符串 → 视作未配置，走 legacy 或默认', () => {
    expect(parseRegion({ KITORA_REGION: '', REGION: 'global' })).toBe('GLOBAL');
    expect(parseRegion({ KITORA_REGION: '' })).toBe('GLOBAL');
  });
});

describe('isLegacyRegionFallback', () => {
  it('canonical 合法 → 不是 legacy 路径', () => {
    expect(isLegacyRegionFallback({ KITORA_REGION: 'CN', REGION: 'global' })).toBeNull();
  });

  it('canonical 缺失 + legacy 合法 → 返回 legacy 字符串供 logger 用', () => {
    expect(isLegacyRegionFallback({ REGION: 'cn' })).toBe('cn');
    expect(isLegacyRegionFallback({ REGION: 'global' })).toBe('global');
  });

  it('canonical 是垃圾值 + legacy 合法 → 返回 legacy（与 parseRegion 锁步）', () => {
    expect(isLegacyRegionFallback({ KITORA_REGION: 'XX', REGION: 'cn' })).toBe('cn');
  });

  it('两个都缺失 → null', () => {
    expect(isLegacyRegionFallback({})).toBeNull();
  });

  it('只有 legacy，但值不在白名单 → null', () => {
    expect(isLegacyRegionFallback({ REGION: 'eu' })).toBeNull();
    expect(isLegacyRegionFallback({ REGION: 'mars' })).toBeNull();
  });
});
