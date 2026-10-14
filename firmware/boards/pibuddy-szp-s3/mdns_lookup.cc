#include "mdns_lookup.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <lwip/inet.h>
#include <lwip/sockets.h>

#include <cstring>
#include <map>
#include <vector>

#define TAG "PiBuddyMdns"

namespace {

constexpr uint16_t kTypeA = 1;
constexpr uint16_t kTypePtr = 12;
constexpr uint16_t kTypeSrv = 33;

uint16_t Read16(const uint8_t* p) { return (p[0] << 8) | p[1]; }

// 读一个 DNS 名字（支持压缩指针），返回小写的点分形式；pos 移到名字之后
bool ReadName(const uint8_t* msg, size_t len, size_t& pos, std::string& out) {
    out.clear();
    size_t p = pos;
    bool jumped = false;
    int hops = 0;
    while (p < len) {
        uint8_t n = msg[p];
        if (n == 0) {
            if (!jumped) pos = p + 1;
            return true;
        }
        if ((n & 0xC0) == 0xC0) {
            if (p + 1 >= len || ++hops > 16) return false;
            if (!jumped) pos = p + 2;
            p = ((n & 0x3F) << 8) | msg[p + 1];
            jumped = true;
            continue;
        }
        if (p + 1 + n > len) return false;
        if (!out.empty()) out += '.';
        for (int i = 0; i < n; ++i) out += (char)tolower(msg[p + 1 + i]);
        p += 1 + n;
    }
    return false;
}

std::vector<uint8_t> BuildQuery(const char* service) {
    std::vector<uint8_t> q = {0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0};
    const char* s = service;
    while (*s) {
        const char* dot = strchr(s, '.');
        size_t n = dot ? (size_t)(dot - s) : strlen(s);
        q.push_back((uint8_t)n);
        q.insert(q.end(), s, s + n);
        s += n;
        if (*s == '.') ++s;
    }
    q.push_back(0);
    q.insert(q.end(), {0, kTypePtr, 0, 1});
    return q;
}

struct Srv {
    uint16_t port;
    std::string target;
};

// 解析一个 mDNS 响应；找到目标服务时填好 ip/port 并返回 true
bool ParseResponse(const uint8_t* msg, size_t len, const std::string& service, const in_addr& from,
                   std::string& ip, uint16_t& port) {
    if (len < 12 || !(msg[2] & 0x80)) return false;
    int qd = Read16(msg + 4);
    int rr = Read16(msg + 6) + Read16(msg + 8) + Read16(msg + 10);
    size_t pos = 12;
    std::string name;
    for (int i = 0; i < qd; ++i) {
        if (!ReadName(msg, len, pos, name) || pos + 4 > len) return false;
        pos += 4;
    }
    std::string instance;
    std::map<std::string, Srv> srvs;
    std::map<std::string, std::string> addrs;
    for (int i = 0; i < rr; ++i) {
        if (!ReadName(msg, len, pos, name) || pos + 10 > len) return false;
        uint16_t type = Read16(msg + pos);
        uint16_t rdlen = Read16(msg + pos + 8);
        size_t rdata = pos + 10;
        if (rdata + rdlen > len) return false;
        if (type == kTypePtr && name == service) {
            size_t p = rdata;
            ReadName(msg, len, p, instance);
        } else if (type == kTypeSrv && rdlen >= 7) {
            size_t p = rdata + 6;
            Srv srv{Read16(msg + rdata + 4), ""};
            ReadName(msg, len, p, srv.target);
            srvs[name] = srv;
        } else if (type == kTypeA && rdlen == 4) {
            char buf[16];
            snprintf(buf, sizeof(buf), "%d.%d.%d.%d", msg[rdata], msg[rdata + 1], msg[rdata + 2], msg[rdata + 3]);
            addrs[name] = buf;
        }
        pos = rdata + rdlen;
    }
    if (instance.empty()) return false;
    auto srv = srvs.find(instance);
    if (srv == srvs.end()) return false;
    port = srv->second.port;
    auto a = addrs.find(srv->second.target);
    // 响应里没带 A 记录时，用发出这个响应的地址
    ip = a != addrs.end() ? a->second : inet_ntoa(from);
    return true;
}

}  // namespace

bool MdnsLookup(const char* service, std::string& ip, uint16_t& port, int timeout_ms) {
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) return false;
    int yes = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    sockaddr_in local = {};
    local.sin_family = AF_INET;
    local.sin_port = htons(5353);
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(sock, (sockaddr*)&local, sizeof(local)) < 0) {
        ESP_LOGW(TAG, "bind 5353 failed: %d", errno);
        close(sock);
        return false;
    }
    ip_mreq mreq = {};
    mreq.imr_multiaddr.s_addr = inet_addr("224.0.0.251");
    mreq.imr_interface.s_addr = htonl(INADDR_ANY);
    setsockopt(sock, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));
    uint8_t ttl = 255;
    setsockopt(sock, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
    timeval tv = {0, 300 * 1000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    sockaddr_in group = {};
    group.sin_family = AF_INET;
    group.sin_port = htons(5353);
    group.sin_addr.s_addr = inet_addr("224.0.0.251");

    auto query = BuildQuery(service);
    std::string want(service);
    for (auto& c : want) c = tolower(c);
    std::vector<uint8_t> buf(1500);
    bool found = false;
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    int64_t next_send = 0;
    while (!found && esp_timer_get_time() < deadline) {
        if (esp_timer_get_time() >= next_send) {
            sendto(sock, query.data(), query.size(), 0, (sockaddr*)&group, sizeof(group));
            next_send = esp_timer_get_time() + 1000 * 1000;
        }
        sockaddr_in from = {};
        socklen_t fromlen = sizeof(from);
        int n = recvfrom(sock, buf.data(), buf.size(), 0, (sockaddr*)&from, &fromlen);
        if (n > 0) found = ParseResponse(buf.data(), n, want, from.sin_addr, ip, port);
    }
    setsockopt(sock, IPPROTO_IP, IP_DROP_MEMBERSHIP, &mreq, sizeof(mreq));
    close(sock);
    if (found) ESP_LOGI(TAG, "found %s at %s:%u", service, ip.c_str(), port);
    return found;
}
