import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';

/**
 * 邮件布局组件的 Props 接口。
 * @property {string} preview - 邮件预览文本（客户端展示）
 * @property {string} heading - 邮件主标题
 * @property {React.ReactNode} children - 邮件正文内容
 * @property {string} [footerNote] - 法律行上方的页脚注释，通常是"如果你没有……忽略"类的免责声明
 * @property {string} [brand="Kitora"] - 在页眉和页脚中显示的品牌名称
 */
interface EmailLayoutProps {
  preview: string;
  heading: string;
  children: React.ReactNode;
  footerNote?: string;
  brand?: string;
}

/**
 * 邮件布局公共框架组件。
 *
 * 为所有事务性邮件提供统一的页眉、容器宽度、页脚免责声明和品牌行。
 * 各个邮件模板只需注入预览文本、标题和正文内容即可。
 *
 * @param {EmailLayoutProps} props - 布局组件的配置项
 * @returns {React.ReactElement} 包装好的邮件 HTML 结构
 */
export function EmailLayout({
  preview,
  heading,
  children,
  footerNote,
  brand = 'Kitora',
}: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-zinc-50 font-sans">
          <Container className="mx-auto max-w-xl px-6 py-10">
            <Section>
              <Text className="m-0 text-sm font-semibold tracking-tight text-zinc-900">
                {brand}
              </Text>
            </Section>
            <Section className="mt-6 rounded-xl border border-zinc-200 bg-white px-8 py-10">
              <Heading className="m-0 text-2xl font-bold tracking-tight text-zinc-900">
                {heading}
              </Heading>
              <div className="mt-4 space-y-4">{children}</div>
            </Section>
            <Hr className="my-6 border-zinc-200" />
            {footerNote ? <Text className="m-0 text-xs text-zinc-500">{footerNote}</Text> : null}
            <Text className="mt-4 text-xs text-zinc-400">
              © {new Date().getFullYear()} {brand}.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
