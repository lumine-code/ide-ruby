# Signal Lab
samples = [0.2, 0.8, -0.4, 0.5, 1.0]

def average(values)
  total = values.sum
  total.to_f / values.length

puts average(samples)
