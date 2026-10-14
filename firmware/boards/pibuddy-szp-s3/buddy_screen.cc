#include "buddy_screen.h"

#include "display.h"
#include "lvgl_theme.h"

#include <esp_heap_caps.h>
#include <esp_log.h>

#define TAG "BuddyScreen"

namespace {

constexpr int kWidth = 320;
constexpr int kCanvasHeight = 196;   // 下面 44 像素是状态栏
constexpr int kCell = 7;             // draw.py 的 S
constexpr int kOriginX = 112;        // draw.py 的 OX, OY
constexpr int kOriginY = 44;

constexpr uint32_t kBg = 0x26313A;
constexpr uint32_t kCream = 0xF8F5ED;
constexpr uint32_t kTeal = 0x4F90AA;
constexpr uint32_t kDeep = 0x276D89;
constexpr uint32_t kMuted = 0xA9B0B5;
constexpr uint32_t kAmber = 0xF1BE58;
constexpr uint32_t kCoral = 0xE5645A;
constexpr uint32_t kBar = 0x1C242B;

// 与 assets/mascot/draw.py 的 P_ROWS、DOT 逐字一致
const char* const kPRows[] = {
    "#########...",
    "###########.",
    "############",
    "####.....###",
    "####.....###",
    "####.....###",
    "####.....###",
    "############",
    "###########.",
    "#########...",
    "####........",
    "####........",
    "####........",
    "####........",
    "####........",
    "####........",
};
const char* const kDot[] = {".oo.", "oooo", "oooo", ".oo."};

inline uint16_t Rgb565(uint32_t rgb) {
    return ((rgb >> 8) & 0xF800) | ((rgb >> 5) & 0x07E0) | ((rgb >> 3) & 0x001F);
}

}  // namespace

void BuddyScreen::FillRect(int x, int y, int w, int h, uint32_t rgb) {
    uint16_t c = Rgb565(rgb);
    for (int yy = std::max(0, y); yy < std::min(kCanvasHeight, y + h); ++yy) {
        for (int xx = std::max(0, x); xx < std::min(kWidth, x + w); ++xx) {
            pixels_[yy * kWidth + xx] = c;
        }
    }
}

void BuddyScreen::FillCell(int x, int y, uint32_t rgb, int dx, int dy) {
    FillRect(kOriginX + (x + dx) * kCell, kOriginY + (y + dy) * kCell, kCell, kCell, rgb);
}

void BuddyScreen::Init(Display* display) {
    display_ = display;
    pixels_ = (uint16_t*)heap_caps_aligned_alloc(64, kWidth * kCanvasHeight * 2, MALLOC_CAP_SPIRAM);
    if (pixels_ == nullptr) {
        ESP_LOGE(TAG, "canvas buffer alloc failed");
        return;
    }
    DisplayLockGuard lock(display_);
    root_ = lv_obj_create(lv_layer_top());
    lv_obj_remove_style_all(root_);
    lv_obj_set_size(root_, kWidth, 240);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_hex(kBg), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_add_flag(root_, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(root_, [](lv_event_t* e) {
        auto self = static_cast<BuddyScreen*>(lv_event_get_user_data(e));
        if (self->on_touch_) self->on_touch_();
    }, LV_EVENT_PRESSED, this);

    canvas_ = lv_canvas_create(root_);
    lv_canvas_set_buffer(canvas_, pixels_, kWidth, kCanvasHeight, LV_COLOR_FORMAT_RGB565);
    lv_obj_set_pos(canvas_, 0, 0);
    lv_obj_remove_flag(canvas_, LV_OBJ_FLAG_CLICKABLE);

    auto bar = lv_obj_create(root_);
    lv_obj_remove_style_all(bar);
    lv_obj_set_size(bar, kWidth, 240 - kCanvasHeight);
    lv_obj_set_pos(bar, 0, kCanvasHeight);
    lv_obj_set_style_bg_color(bar, lv_color_hex(kBar), 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_remove_flag(bar, LV_OBJ_FLAG_CLICKABLE);

    accent_ = lv_obj_create(root_);
    lv_obj_remove_style_all(accent_);
    lv_obj_set_size(accent_, 4, 240 - kCanvasHeight);
    lv_obj_set_pos(accent_, 0, kCanvasHeight);
    lv_obj_set_style_bg_opa(accent_, LV_OPA_COVER, 0);
    lv_obj_remove_flag(accent_, LV_OBJ_FLAG_CLICKABLE);

    auto theme = static_cast<LvglTheme*>(display_->GetTheme());
    const lv_font_t* font = theme && theme->text_font() ? theme->text_font()->font() : LV_FONT_DEFAULT;

    status_ = lv_label_create(root_);
    lv_obj_set_style_text_font(status_, font, 0);
    lv_obj_set_pos(status_, 12, kCanvasHeight - 1);
    lv_obj_set_width(status_, kWidth - 20);
    lv_label_set_long_mode(status_, LV_LABEL_LONG_MODE_DOTS);

    detail_ = lv_label_create(root_);
    lv_obj_set_style_text_font(detail_, font, 0);
    lv_obj_set_style_text_color(detail_, lv_color_hex(kMuted), 0);
    lv_obj_set_pos(detail_, 12, kCanvasHeight + 20);
    lv_obj_set_width(detail_, kWidth - 20);
    lv_label_set_long_mode(detail_, LV_LABEL_LONG_MODE_DOTS);

    auto mark = lv_label_create(root_);
    lv_obj_set_style_text_font(mark, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(mark, lv_color_hex(kMuted), 0);
    lv_label_set_text(mark, "P. pi");
    lv_obj_set_pos(mark, 262, 6);

    // 请示时的两个触摸按钮，放在 P 的脚下面（P 的最下一行到 y=156）
    buttons_ = lv_obj_create(root_);
    lv_obj_remove_style_all(buttons_);
    lv_obj_set_size(buttons_, kWidth, 38);
    lv_obj_set_pos(buttons_, 0, 157);
    lv_obj_remove_flag(buttons_, LV_OBJ_FLAG_SCROLLABLE);
    auto make_button = [this](int x, uint32_t color, const char* text, bool allow) {
        auto btn = lv_button_create(buttons_);
        lv_obj_set_size(btn, 148, 38);
        lv_obj_set_pos(btn, x, 0);
        lv_obj_set_style_radius(btn, 6, 0);
        lv_obj_set_style_shadow_width(btn, 0, 0);
        lv_obj_set_style_bg_color(btn, lv_color_hex(color), 0);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        auto label = lv_label_create(btn);
        lv_label_set_text(label, text);
        lv_obj_set_style_text_color(label, lv_color_hex(kCream), 0);
        lv_obj_center(label);
        lv_obj_add_event_cb(btn, [](lv_event_t* e) {
            auto self = static_cast<BuddyScreen*>(lv_event_get_user_data(e));
            // 请示刚出现时手指可能正好落在按钮上，这一下不算
            if (lv_tick_elaps(self->buttons_shown_at_) < 400) return;
            bool allow = lv_obj_get_user_data(static_cast<lv_obj_t*>(lv_event_get_target(e))) != nullptr;
            if (self->on_decision_) self->on_decision_(allow);
        }, LV_EVENT_CLICKED, this);
        lv_obj_set_user_data(btn, allow ? (void*)1 : nullptr);
    };
    make_button(8, kDeep, "允许", true);
    make_button(164, kCoral, "拒绝", false);

    corner_ = lv_label_create(root_);
    lv_obj_set_style_text_font(corner_, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(corner_, lv_color_hex(kMuted), 0);
    lv_obj_set_pos(corner_, 10, 6);
    lv_label_set_text(corner_, "");
    lv_obj_add_flag(buttons_, LV_OBJ_FLAG_HIDDEN);

    // 按住 BOOT 时盖在按钮上面的进度条
    hold_ = lv_obj_create(root_);
    lv_obj_remove_style_all(hold_);
    lv_obj_set_size(hold_, kWidth, 38);
    lv_obj_set_pos(hold_, 0, 157);
    lv_obj_set_style_bg_color(hold_, lv_color_hex(kBg), 0);
    lv_obj_set_style_bg_opa(hold_, LV_OPA_COVER, 0);
    lv_obj_remove_flag(hold_, LV_OBJ_FLAG_SCROLLABLE);
    auto hold_label = lv_label_create(hold_);
    lv_label_set_text(hold_label, "按住到底 = 允许 · 松开 = 拒绝");
    lv_obj_set_style_text_color(hold_label, lv_color_hex(kCream), 0);
    lv_obj_set_pos(hold_label, 16, 0);
    hold_bar_ = lv_bar_create(hold_);
    lv_obj_set_size(hold_bar_, kWidth - 32, 10);
    lv_obj_set_pos(hold_bar_, 16, 26);
    lv_obj_set_style_bg_color(hold_bar_, lv_color_hex(kBar), LV_PART_MAIN);
    lv_obj_set_style_bg_color(hold_bar_, lv_color_hex(kTeal), LV_PART_INDICATOR);
    lv_bar_set_range(hold_bar_, 0, 1000);
    lv_obj_add_flag(hold_, LV_OBJ_FLAG_HIDDEN);

    lv_obj_add_flag(root_, LV_OBJ_FLAG_HIDDEN);
}

void BuddyScreen::DrawMascot(Face face) {
    FillRect(0, 0, kWidth, kCanvasHeight, kBg);

    // 对应 draw.py 的 body()
    auto body = [this](int dy = 0, bool squash = false) {
        for (int y = 0; y < 16; ++y) {
            for (int x = 0; x < 12; ++x) {
                if (kPRows[y][x] != '#') continue;
                if (squash && y == 15) continue;
                FillCell(x, y, kCream, 0, dy + (squash && y < 10 ? 1 : 0));
            }
        }
    };
    auto dot = [this](int x, int y, uint32_t color = kTeal, bool small = false) {
        if (small) {
            for (int cy = 0; cy < 2; ++cy)
                for (int cx = 0; cx < 2; ++cx) FillCell(x + cx, y + cy, color);
            return;
        }
        for (int cy = 0; cy < 4; ++cy)
            for (int cx = 0; cx < 4; ++cx)
                if (kDot[cy][cx] == 'o') FillCell(x + cx, y + cy, color);
    };
    // 对应 draw.py 的 eyes()
    auto eyes = [this](const char* kind, int dy = 0) {
        std::string k(kind);
        if (k == "open") {
            for (int x : {5, 7}) { FillCell(x, 4, kCream, 0, dy); FillCell(x, 5, kCream, 0, dy); }
        } else if (k == "up") {
            for (int x : {5, 7}) { FillCell(x, 3, kCream, 0, dy); FillCell(x, 4, kCream, 0, dy); }
        } else if (k == "down") {
            for (int x : {5, 7}) { FillCell(x, 5, kCream, 0, dy); FillCell(x, 6, kCream, 0, dy); }
        } else if (k == "wide") {
            for (int x0 : {4, 7})
                for (int cx = 0; cx < 2; ++cx)
                    for (int cy = 3; cy < 5; ++cy) FillCell(x0 + cx, cy + 1, kCream, 0, dy);
        } else if (k == "happy") {
            for (int x0 : {4, 7}) {
                FillCell(x0, 5, kCream, 0, dy); FillCell(x0 + 1, 4, kCream, 0, dy); FillCell(x0 + 2, 5, kCream, 0, dy);
            }
        } else if (k == "x") {
            const int pts[5][2] = {{0, 0}, {2, 0}, {1, 1}, {0, 2}, {2, 2}};
            for (int x0 : {4, 7})
                for (auto& p : pts) FillCell(x0 + p[0], 3 + p[1], kCoral, 0, dy);
        } else if (k == "closed") {
            for (int x0 : {4, 7}) { FillCell(x0, 5, kCream, 0, dy); FillCell(x0 + 1, 5, kCream, 0, dy); }
        }
    };

    switch (face) {
    case Face::Idle:
        body(); eyes("open"); dot(8, 12);
        break;
    case Face::Thinking:
        body(); eyes("up");
        dot(13, -4);
        FillCell(12, -1, kTeal); FillCell(11, 0, kTeal);
        break;
    case Face::Working:
        body(); eyes("down");
        dot(9, 13, kTeal, true);
        for (int i = 0; i < 8; ++i) FillCell(5 + i, 16, i % 2 == 0 ? kMuted : kDeep);
        break;
    case Face::Permission:
        body(); eyes("wide");
        for (int y = -1; y < 3; ++y) FillCell(12, y, kTeal);
        dot(11, -5, kAmber);
        break;
    case Face::Done: {
        body(-3); eyes("happy", -3);
        dot(13, -5);
        const int sparks[5][2] = {{-3, -2}, {15, 2}, {-2, 6}, {16, -2}, {14, -7}};
        for (auto& s : sparks) FillCell(s[0], s[1], kCream);
        break;
    }
    case Face::Error:
        body(); eyes("x");
        dot(15, 12);
        FillCell(13, 15, kMuted);
        break;
    case Face::Sleep: {
        body(0, true); eyes("closed", 1);
        const int z[7][2] = {{0, 0}, {1, 0}, {2, 0}, {1, 1}, {0, 2}, {1, 2}, {2, 2}};
        for (auto& p : z) FillCell(12 + p[0], -1 + p[1], kTeal);
        for (auto& p : z) FillCell(15 + p[0], -4 + p[1], kDeep);
        break;
    }
    }
}

void BuddyScreen::Render(Face face, const std::string& status, const std::string& detail, uint32_t accent) {
    if (root_ == nullptr) return;
    DisplayLockGuard lock(display_);
    DrawMascot(face);
    lv_obj_invalidate(canvas_);
    // 中文字体在 assets 加载后才换上，每次渲染时跟随当前主题
    auto theme = static_cast<LvglTheme*>(display_->GetTheme());
    if (theme && theme->text_font()) {
        const lv_font_t* font = theme->text_font()->font();
        if (lv_obj_get_style_text_font(status_, LV_PART_MAIN) != font) {
            lv_obj_set_style_text_font(status_, font, 0);
            lv_obj_set_style_text_font(detail_, font, 0);
            lv_obj_set_style_text_font(buttons_, font, 0);
            lv_obj_set_style_text_font(hold_, font, 0);
        }
    }
    lv_obj_set_style_bg_color(accent_, lv_color_hex(accent), 0);
    lv_obj_set_style_text_color(status_, lv_color_hex(accent), 0);
    lv_label_set_text(status_, status.c_str());
    lv_label_set_text(detail_, detail.c_str());
    if (face == Face::Permission) {
        if (lv_obj_has_flag(buttons_, LV_OBJ_FLAG_HIDDEN)) buttons_shown_at_ = lv_tick_get();
        lv_obj_remove_flag(buttons_, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(buttons_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(hold_, LV_OBJ_FLAG_HIDDEN);
    }
}

void BuddyScreen::SetCorner(const std::string& text) {
    if (root_ == nullptr) return;
    DisplayLockGuard lock(display_);
    lv_label_set_text(corner_, text.c_str());
}

void BuddyScreen::ShowHold(bool show, int hold_ms) {
    if (root_ == nullptr) return;
    DisplayLockGuard lock(display_);
    lv_anim_delete(hold_bar_, nullptr);
    if (!show) {
        lv_obj_add_flag(hold_, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    lv_bar_set_value(hold_bar_, 0, LV_ANIM_OFF);
    lv_obj_remove_flag(hold_, LV_OBJ_FLAG_HIDDEN);
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, hold_bar_);
    lv_anim_set_values(&a, 0, 1000);
    lv_anim_set_duration(&a, hold_ms);
    lv_anim_set_exec_cb(&a, [](void* bar, int32_t v) {
        lv_bar_set_value(static_cast<lv_obj_t*>(bar), v, LV_ANIM_OFF);
    });
    lv_anim_start(&a);
}

void BuddyScreen::SetVisible(bool visible) {
    if (root_ == nullptr || visible == visible_) return;
    DisplayLockGuard lock(display_);
    if (visible) {
        lv_obj_remove_flag(root_, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(root_, LV_OBJ_FLAG_HIDDEN);
    }
    visible_ = visible;
}
