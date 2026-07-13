#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

int main(void)
{
    const uint64_t virtual_address_bits = 48;
    const uint64_t page_offset_bits = 12;
    const uint64_t pte_size = 8;
    const uint64_t num_pages =
        UINT64_C(1) << (virtual_address_bits - page_offset_bits);
    const uint64_t table_size = num_pages * pte_size;

    printf("pages: %" PRIu64 ", table size: %" PRIu64 " GiB\n",
           num_pages, table_size / (UINT64_C(1) << 30));
    return 0;
}
