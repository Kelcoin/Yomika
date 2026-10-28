// Regression probe for NNAPI TLS destructor lifetime. Run under adb.
#include <dlfcn.h>
#include <thread>
#include <cstdio>
int main() {
  for (int i=0;i<8;++i) std::thread([] {
    // Do not dlclose: NNAPI TLS destructors may run after this function returns.
    auto h=dlopen("libneuralnetworks.so",RTLD_NOW | RTLD_NODELETE);
    if(!h)return;
    auto count=reinterpret_cast<int(*)(unsigned*)>(dlsym(h,"ANeuralNetworks_getDeviceCount"));
    unsigned n=0;if(count)count(&n);
  }).join();
  puts("8 NNAPI worker thread exits survived");
}
