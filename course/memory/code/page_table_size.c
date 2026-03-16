// page_table_size.c — 计算平铺页表的大小
#include <stdio.h>

int main(void) {
    unsigned long virt_bits = 48;                       // x86-64 虚拟地址宽度
    unsigned long pte_size  = 8;                        // 每个 PTE 8 字节
    unsigned long num_pages = 1UL << (virt_bits - 12);  // 2^36 个虚拟页
    unsigned long table_size = num_pages * pte_size;    // 2^36 × 8 = 512 GB

    printf("pages: %lu, table size: %lu GB\n",
           num_pages, table_size / (1UL << 30));
    return 0;
}
