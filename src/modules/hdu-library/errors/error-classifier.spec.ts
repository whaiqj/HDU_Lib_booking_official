import { classifyError } from './error-classifier';
import { ErrorCategory } from './error-category.enum';

describe('classifyError', () => {
  it('已有预约类文案分类为 ALREADY_BOOKED（来源不可区分，worker 按可重试继续打）', () => {
    expect(classifyError({ MESSAGE: '您已有预约，请勿重复预约' })).toBe(
      ErrorCategory.ALREADY_BOOKED,
    );
    expect(classifyError({ msg: '重复预约' })).toBe(
      ErrorCategory.ALREADY_BOOKED,
    );
  });

  it('ALREADY_BOOKED 优先于 SEAT_UNAVAILABLE 匹配（文案字面接近）', () => {
    // "已被预约"属于座位被占；"已有预约"是另一类文案 —— 两者必须区分开
    expect(classifyError({ MESSAGE: '座位已被预约' })).toBe(
      ErrorCategory.SEAT_UNAVAILABLE,
    );
  });

  it('未知文案仍兜底为 UNKNOWN', () => {
    expect(classifyError({ MESSAGE: '系统繁忙，请稍后再试' })).toBe(
      ErrorCategory.UNKNOWN,
    );
  });
});
