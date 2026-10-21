//! 生成应用图标
//!
//! 为什么自己画而不是放一个占位图：
//! 这个图标会出现在任务栏、桌面快捷方式和安装程序里，是用户每天看到的东西。
//! 用默认的 Tauri 图标或者一个纯色方块，会让整个工具看起来像半成品。
//!
//! 图形构思：夜蓝底 + 暖琥珀的「书脊 + 三条刻痕」。
//! 和界面的视觉语言一致 —— 深色为底、单一琥珀强调色、不用渐变和发光。
//! 三条刻痕对应这个工具的三件事：设定、关系、时间。
//!
//! 跑法：cd src-tauri && cargo run --bin make-icons
//! 它会把每个平台需要的尺寸写进 src-tauri/icons/。

use image::{Rgba, RgbaImage};

/// 与界面设计系统一致的颜色
const BG_TOP: [u8; 3] = [17, 20, 29]; // --color-surface
const BG_BOTTOM: [u8; 3] = [10, 12, 18]; // --color-base
const AMBER: [u8; 3] = [217, 163, 85]; // --color-accent
const INK: [u8; 3] = [233, 235, 242]; // --color-ink

/// 圆角半径占边长的比例
const CORNER: f32 = 0.22;

fn main() {
    const SIZE: u32 = 1024;
    let img = render(SIZE);
    std::fs::create_dir_all("icons").expect("创建 icons 目录失败");

    // 源图：给 tauri icon 命令和各平台打包用
    img.save("icons/icon.png").expect("写出 icon.png 失败");
    println!("已生成 icons/icon.png ({SIZE}x{SIZE})");

    // 直接按目录约定生成 Tauri 需要的几种尺寸。
    // 这样不依赖 @tauri-apps/cli，在离线或沙箱环境里也能出图标。
    let png_targets: &[(&str, u32)] = &[
        ("icons/32x32.png", 32),
        ("icons/128x128.png", 128),
        ("icons/128x128@2x.png", 256),
        ("icons/icon-512.png", 512),
    ];
    for (path, size) in png_targets {
        image::imageops::resize(&img, *size, *size, image::imageops::FilterType::Lanczos3)
            .save(path)
            .unwrap_or_else(|e| panic!("写出 {path} 失败: {e}"));
        println!("已生成 {path} ({size}x{size})");
    }

    // Windows 图标：多尺寸打包进一个 .ico
    write_ico(&img, "icons/icon.ico");
    println!("已生成 icons/icon.ico");

    println!("\n完成。现在可以跑 cargo test 或 npm run desktop:build。");
}

/// 画出图标本身
fn render(size: u32) -> RgbaImage {
    let mut img = RgbaImage::new(size, size);
    let s = size as f32;
    let radius = s * CORNER;

    for y in 0..size {
        for x in 0..size {
            let (fx, fy) = (x as f32, y as f32);
            let coverage = rounded_rect_coverage(fx, fy, s, radius);
            if coverage <= 0.0 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
                continue;
            }
            // 竖直方向的极淡渐变：不是装饰，是让圆角在深色背景上有体积感
            let t = fy / s;
            let base = lerp3(BG_TOP, BG_BOTTOM, t);
            img.put_pixel(x, y, Rgba([base[0], base[1], base[2], (255.0 * coverage) as u8]));
        }
    }

    // 「书脊」：一条竖直的琥珀竖线，圆头
    let spine_w = s * 0.055;
    let spine_x = s * 0.315;
    let spine_top = s * 0.26;
    let spine_bottom = s * 0.74;
    paint_rounded_bar(
        &mut img,
        spine_x,
        spine_top,
        spine_w,
        spine_bottom - spine_top,
        spine_w / 2.0,
        AMBER,
        1.0,
    );

    // 三条刻痕：长短不一的横线，右端对齐，模拟书页上的字行。
    // 刻意不等长 —— 等长会显得像菜单图标。
    let rows: &[(f32, f32, f32)] = &[
        // (起点x比例, 长度比例, 线宽比例)
        (0.46, 0.36, 0.052),
        (0.46, 0.24, 0.052),
        (0.46, 0.30, 0.052),
    ];
    let gap = 0.105;
    let first_y = 0.365;
    for (i, (x0, len, w)) in rows.iter().enumerate() {
        let y = s * (first_y + gap * i as f32);
        // 最后一条用琥珀色收尾，让三条里有主次
        let color = if i == rows.len() - 1 { AMBER } else { INK };
        let alpha = if i == rows.len() - 1 { 1.0 } else { 0.86 };
        paint_rounded_bar(
            &mut img,
            s * x0,
            y,
            s * len,
            s * w,
            s * w / 2.0,
            color,
            alpha,
        );
    }

    img
}

/// 圆角矩形的覆盖率（4x4 超采样，边缘不毛糙）
fn rounded_rect_coverage(x: f32, y: f32, size: f32, radius: f32) -> f32 {
    const N: u32 = 4;
    let mut hits = 0;
    for sy in 0..N {
        for sx in 0..N {
            let px = x + (sx as f32 + 0.5) / N as f32;
            let py = y + (sy as f32 + 0.5) / N as f32;
            // 把点折到第一象限，只判断一个圆角
            let cx = if px < radius {
                radius
            } else if px > size - radius {
                size - radius
            } else {
                px
            };
            let cy = if py < radius {
                radius
            } else if py > size - radius {
                size - radius
            } else {
                py
            };
            let in_corner_zone = px < radius || px > size - radius;
            let in_corner_zone_y = py < radius || py > size - radius;
            let inside = if in_corner_zone && in_corner_zone_y {
                let dx = px - cx;
                let dy = py - cy;
                dx * dx + dy * dy <= radius * radius
            } else {
                px >= 0.0 && px <= size && py >= 0.0 && py <= size
            };
            if inside {
                hits += 1;
            }
        }
    }
    hits as f32 / (N * N) as f32
}

/// 画一条圆角横条（或竖条），带 4x4 抗锯齿
#[allow(clippy::too_many_arguments)]
fn paint_rounded_bar(
    img: &mut RgbaImage,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: f32,
    color: [u8; 3],
    alpha: f32,
) {
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    let x0 = (x - 1.0).floor().max(0.0) as i32;
    let y0 = (y - 1.0).floor().max(0.0) as i32;
    let x1 = (x + w + 1.0).ceil().min(iw as f32) as i32;
    let y1 = (y + h + 1.0).ceil().min(ih as f32) as i32;

    const N: u32 = 4;
    for py in y0..y1 {
        for px in x0..x1 {
            let mut hits = 0;
            for sy in 0..N {
                for sx in 0..N {
                    let fx = px as f32 + (sx as f32 + 0.5) / N as f32;
                    let fy = py as f32 + (sy as f32 + 0.5) / N as f32;
                    if inside_rounded_bar(fx, fy, x, y, w, h, r) {
                        hits += 1;
                    }
                }
            }
            if hits == 0 {
                continue;
            }
            let cov = (hits as f32 / (N * N) as f32) * alpha;
            blend(img, px as u32, py as u32, color, cov);
        }
    }
}

fn inside_rounded_bar(
    px: f32,
    py: f32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: f32,
) -> bool {
    if px < x || px > x + w || py < y || py > y + h {
        return false;
    }
    let r = r.min(w / 2.0).min(h / 2.0);
    if r <= 0.0 {
        return true;
    }
    // 折到第一象限判断圆角
    let cx = if px < x + r {
        x + r
    } else if px > x + w - r {
        x + w - r
    } else {
        px
    };
    let cy = if py < y + r {
        y + r
    } else if py > y + h - r {
        y + h - r
    } else {
        py
    };
    let in_x = px < x + r || px > x + w - r;
    let in_y = py < y + r || py > y + h - r;
    if in_x && in_y {
        let dx = px - cx;
        let dy = py - cy;
        dx * dx + dy * dy <= r * r
    } else {
        true
    }
}

/// 把颜色按覆盖率混到像素上（源覆盖目标）
fn blend(img: &mut RgbaImage, x: u32, y: u32, color: [u8; 3], cov: f32) {
    if x >= img.width() || y >= img.height() || cov <= 0.0 {
        return;
    }
    let dst = img.get_pixel(x, y).0;
    let a = cov.clamp(0.0, 1.0);
    // 目标有透明区时，混合后要保持可见
    let out_a = dst[3] as f32 / 255.0;
    let new_a = a + out_a * (1.0 - a);
    if new_a <= 0.0 {
        img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
        return;
    }
    let mix = |src: u8, dstc: u8| -> u8 {
        let v = (src as f32 * a + dstc as f32 * out_a * (1.0 - a)) / new_a;
        v.round().clamp(0.0, 255.0) as u8
    };
    img.put_pixel(
        x,
        y,
        Rgba([
            mix(color[0], dst[0]),
            mix(color[1], dst[1]),
            mix(color[2], dst[2]),
            (new_a * 255.0).round() as u8,
        ]),
    );
}

fn lerp3(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t).round() as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t).round() as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t).round() as u8,
    ]
}

/// 写一个多尺寸的 .ico。格式很简单，自己拼比引依赖省事。
fn write_ico(src: &RgbaImage, path: &str) {
    let sizes = [16u32, 24, 32, 48, 64, 128, 256];
    let mut pngs: Vec<(u32, Vec<u8>)> = Vec::new();
    for s in sizes {
        let resized = image::imageops::resize(src, s, s, image::imageops::FilterType::Lanczos3);
        let mut buf = std::io::Cursor::new(Vec::new());
        resized
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("png 编码失败");
        pngs.push((s, buf.into_inner()));
    }

    let mut out: Vec<u8> = Vec::new();
    // ICONDIR
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type = icon
    out.extend_from_slice(&(pngs.len() as u16).to_le_bytes());

    // 图像数据从头部之后开始
    let header_len = 6 + 16 * pngs.len();
    let mut offset = header_len;
    for (size, data) in &pngs {
        let dim = if *size >= 256 { 0u8 } else { *size as u8 }; // 256 记作 0
        out.push(dim); // width
        out.push(dim); // height
        out.push(0); // 调色板数
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // color planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += data.len();
    }
    for (_, data) in &pngs {
        out.extend_from_slice(data);
    }

    std::fs::write(path, out).unwrap_or_else(|e| panic!("写出 {path} 失败: {e}"));
}
