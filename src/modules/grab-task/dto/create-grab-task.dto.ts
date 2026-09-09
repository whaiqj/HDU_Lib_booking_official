import { IsString, IsNumber, IsArray, IsBoolean, IsOptional, Min } from 'class-validator';

/**
 * 座位偏好拆分：任何非字母数字字符均视为分隔符。
 * 2026-09-09 事故：全角逗号输入 "204，205，206" 未被拆分，整串被当作一个
 * 座位号，预解析永远找不到，盲抢全程 0 次预约请求。前端
 * （utils/seatPreference.ts）做同样处理；项目未启用 ValidationPipe，
 * 后端在 GrabTaskService.create() 手动调用本函数兜底。
 */
export function splitSeatTokens(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((v) =>
    typeof v === 'string' ? (v.match(/[0-9A-Za-z]+/g) ?? []) : [v],
  );
}

/**
 * 创建抢座任务请求 DTO
 */
export class CreateGrabTaskDto {
  @IsString()
  accountId: string;

  /** 空间分类 ID（可选，后端默认填充自习室分类 591） */
  @IsString()
  @IsOptional()
  categoryId?: string;

  /** 空间内容 ID（可选，后端默认填充自习室分类 3） */
  @IsString()
  @IsOptional()
  contentId?: string;

  /** 指定房间 ID（可选，对应第三方 info.id，如 二楼东=1557）。多房间分类下锁定房间，座位号才能唯一解析为 seatId */
  @IsString()
  @IsOptional()
  roomId?: string;

  /** 指定房间名称（可选，展示用） */
  @IsString()
  @IsOptional()
  roomName?: string;

  @IsNumber()
  beginTime: number;

  @IsNumber()
  @Min(1)
  duration: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  seatPreference?: string[];

  @IsBoolean()
  @IsOptional()
  strictMode?: boolean;

  @IsNumber()
  triggerAt: number;
}