#ifndef PIBUDDY_MDNS_LOOKUP_H
#define PIBUDDY_MDNS_LOOKUP_H

#include <cstdint>
#include <string>

// 一次性的 mDNS 查询：找局域网里的 _pibuddy._tcp 服务，返回桥接程序的 IPv4 地址和端口。
// 不常驻、不引入 mdns 组件，用完即关 socket，尽量少占内部内存。
bool MdnsLookup(const char* service, std::string& ip, uint16_t& port, int timeout_ms);

#endif
