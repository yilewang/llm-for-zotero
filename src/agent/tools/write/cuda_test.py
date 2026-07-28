import torch
print(torch.cuda.is_available())  # must be True
print(torch.version.cuda)         # shows the CUDA version PyTorch was built with