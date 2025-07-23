// MOTD 组件和构建函数
// 基于 https://github.com/Ikaleio/transit/blob/main/src/motd.ts

import { z } from "zod";
import * as chat from "mc-chat-format";
import { v4 as uuidv4 } from "uuid";

import DEFAULT_MOTD_FAVICON from "../assets/default-favicon.txt";

// 文本组件类型定义
export const Component: z.ZodType<any> = z
  .union([
    z.object({
      text: z.string(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underlined: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      obfuscated: z.boolean().optional(),
      color: z.string().optional(),
      insertion: z.string().optional(),
      extra: z.array(z.lazy(() => Component)).optional(),
    }),
    z.string(),
  ])
  .transform((value) => {
    if (typeof value === "string") {
      return chat.convertOld(value);
    }
    return value;
  });

// MOTD Schema 定义（输出）
export const MotdSchema = z.object({
  version: z.object({
    name: z.string(),
    protocol: z.union([z.number(), z.literal("auto")]),
  }),
  players: z.object({
    max: z.number(),
    online: z.union([z.number(), z.literal("auto")]),
    sample: z
      .array(
        z.union([
          z.object({
            name: z.string(),
            id: z.string(),
          }),
          z.string(),
        ])
      )
      .transform((sample) => {
        return sample.map((player) => {
          if (typeof player === "string") {
            return {
              name: player,
              id: uuidv4(),
            };
          }
          return player;
        });
      }),
  }),
  description: Component,
  favicon: z.string(),
});

// MOTD 输入 Schema 定义（允许部分字段和默认值）
export const MotdInputSchema = z
  .object({
    version: z
      .object({
        name: z.string().optional(),
        protocol: z.union([z.number(), z.literal("auto")]).optional(),
      })
      .optional(),
    players: z
      .object({
        max: z.number().optional(),
        online: z.union([z.number(), z.literal("auto")]).optional(),
        sample: z
          .array(
            z.union([
              z.object({
                name: z.string(),
                id: z.string(),
              }),
              z.string(),
            ])
          )
          .optional(),
      })
      .optional(),
    description: Component.optional(),
    favicon: z.string().optional(),
  })
  .partial();

export type MotdInput = z.input<typeof MotdInputSchema>;
export type MotdType = z.infer<typeof MotdSchema>;
export type PartialMotd = Partial<MotdType>;

// MOTD 回调返回结果类型
export type MotdResult = MotdInput | { disconnect: string };

// 创建默认 MOTD
export const createDefaultMotd = (): MotdType => ({
  version: {
    name: "Geofront",
    protocol: "auto",
  },
  players: {
    max: 20,
    online: "auto",
    sample: [
      { name: "Geofront Proxy", id: uuidv4() },
      { name: "Made by Ikaleio", id: uuidv4() },
    ],
  },
  description: { text: "Geofront Proxy by Ikaleio" },
  favicon: DEFAULT_MOTD_FAVICON,
});

// 构建最终的 MOTD 对象，处理 'auto' 值
export const buildMotd = (
  motd: MotdType,
  onlinePlayers: number,
  protocol: number
): MotdType => {
  if (motd.players.online === "auto") {
    motd.players.online = onlinePlayers;
  }
  if (motd.version.protocol === "auto") {
    motd.version.protocol = protocol;
  }
  return motd;
};
