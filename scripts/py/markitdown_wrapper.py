# markitdown 命令行包装：PyInstaller 打包入口（onedir，控制台程序）
# 用法：markitdown.exe <文件路径> [更多文件...]，转换结果写 stdout，失败写 stderr 并返回非 0
# 说明：保持与官方 markitdown CLI 兼容的「单文件进、markdown 出」行为，
#       images.js 的 runCmd 无需感知差别；批量参数支持是为了将来常驻复用留的口子。
import sys

from markitdown import MarkItDown


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: markitdown <file> [file...]\n")
        return 2
    converter = MarkItDown()
    rc = 0
    for path in sys.argv[1:]:
        try:
            result = converter.convert(path)
            sys.stdout.write(result.text_content or "")
        except Exception as e:  # 单个文件失败不拖垮批量
            sys.stderr.write("convert failed: %s\n" % e)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
