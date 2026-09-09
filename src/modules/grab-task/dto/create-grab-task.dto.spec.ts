import { splitSeatTokens } from './create-grab-task.dto';

/**
 * 回归测试：2026-09-09 事故——座位偏好输入使用全角逗号 "204，205，206"，
 * 未被拆分成独立座位号，整串被当成一个座位标题，预解析永远找不到，
 * 盲抢全程 0 次预约请求。任何非字母数字字符均视为分隔符。
 */
describe('splitSeatTokens', () => {
  it('拆分全角逗号（事故路径）', () => {
    expect(splitSeatTokens(['204，205，206'])).toEqual(['204', '205', '206']);
  });

  it('拆分半角逗号', () => {
    expect(splitSeatTokens(['204,205,206'])).toEqual(['204', '205', '206']);
  });

  it('拆分顿号、空格、分号、斜杠等混合分隔符', () => {
    expect(splitSeatTokens(['204、205 206;207/208'])).toEqual([
      '204',
      '205',
      '206',
      '207',
      '208',
    ]);
  });

  it('单个座位保持不变', () => {
    expect(splitSeatTokens(['206'])).toEqual(['206']);
  });

  it('已拆分的多元素数组保持不变', () => {
    expect(splitSeatTokens(['204', '205', '206'])).toEqual(['204', '205', '206']);
  });

  it('剔除空串与纯分隔符元素', () => {
    expect(splitSeatTokens(['', '，', '204', '，,、'])).toEqual(['204']);
  });

  it('undefined / 非数组返回空数组', () => {
    expect(splitSeatTokens(undefined)).toEqual([]);
  });
});
